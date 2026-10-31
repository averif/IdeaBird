import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { buildTweetPipeline, type Tweet } from './tweetPipeline.js';

// Errors carry HTTP-ish metadata so routes can map them to responses and the
// fallback loop can decide whether to retry.
export interface GenerateError extends Error {
  status?: number;
  httpCode?: number;
  retryable?: boolean;
  timedOut?: boolean;
  emptyResponse?: boolean;
  budgetExhausted?: boolean;
}

/** OpenAI-style message content: plain text, or text + images for vision models. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface ChatCompletionPayload {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
  detail?: string;
}

export interface GenerateResult {
  status: 'ok';
  tweets: Tweet[];
  diagnostics: ReturnType<typeof buildTweetPipeline>['diagnostics'];
  model: string;
}

export function createError(message: string, props: Partial<GenerateError> = {}): GenerateError {
  return Object.assign(new Error(message), props);
}

const NVIDIA_BASE_URL = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || process.env.GEMINI_API_KEY;
// Fail fast: a model that hasn't answered in this time is usually stuck in a queue,
// so moving on to the next fallback model beats waiting it out.
const REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_TIMEOUT_MS || 60000);
const MODEL_ATTEMPTS = Number(process.env.NVIDIA_MODEL_ATTEMPTS || 1);
// How hard reasoning models think before answering. Short posts don't need deep
// reasoning, and reasoning tokens are most of the wait. Set to "" to not send it.
const REASONING_EFFORT = process.env.NVIDIA_REASONING_EFFORT ?? 'low';
// Models known to accept the OpenAI-style `reasoning_effort` parameter.
const SUPPORTS_REASONING_EFFORT = /gpt-oss/i;
// Nemotron models can switch hidden reasoning off via the chat template. For
// writing posts that cut generation time sharply and stopped answers from being
// cut off mid-JSON. Set NVIDIA_WRITER_THINKING=on to keep reasoning.
const SUPPORTS_THINKING_TOGGLE = /nemotron/i;
export const WRITER_THINKING = (process.env.NVIDIA_WRITER_THINKING || 'off').toLowerCase() !== 'off';
// Reasoning models (gpt-oss, nemotron, deepseek, kimi) spend max_tokens on hidden
// reasoning BEFORE emitting `content`. A small budget yields content:null with
// finish_reason:"length" — an empty response, not a model failure. Budget for reasoning.
const MAX_OUTPUT_TOKENS = Number(process.env.NVIDIA_MAX_TOKENS || 4096);
// Don't start a model call with less time than this left in the request budget —
// it would only be aborted mid-reasoning.
const MIN_CALL_BUDGET_MS = 5000;

export function modelList(primary: string | undefined, fallbacks: string | undefined, defaultModel: string): string[] {
  const models = [primary || defaultModel, ...(fallbacks || '').split(',').map((model) => model.trim()).filter(Boolean)];
  return [...new Set(models)];
}

// Writes the posts. Nemotron 3.5 Super VL answered in ~3s in testing, versus 48s+
// for gpt-oss-20b on the same key.
export const MODEL_CANDIDATES = modelList(
  process.env.NVIDIA_MODEL,
  process.env.NVIDIA_FALLBACK_MODELS,
  'nvidia/nemotron-3.5-super-vl-120b-a12b'
);
export const NIM_CONFIG = {
  baseUrl: NVIDIA_BASE_URL,
  modelCandidates: MODEL_CANDIDATES,
};

export function assertApiKey(): void {
  if (!API_KEY) {
    throw createError('NVIDIA_API_KEY is missing. Add it to your environment variables.', { status: 401 });
  }
}

/** A budget (ms) for the whole request becomes an absolute deadline. */
export function deadlineFrom(budgetMs?: number): number {
  return budgetMs ? Date.now() + budgetMs : Infinity;
}

/**
 * Runs `call` against each model in order until one succeeds. Timeouts skip
 * straight to the next model (retrying a queued model just waits again).
 */
export async function withModelFallback<T>(
  models: string[],
  label: string,
  call: (modelName: string, attempt: number) => Promise<T>
): Promise<{ value: T; model: string }> {
  let lastError: GenerateError | null = null;

  for (const modelName of models) {
    for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt += 1) {
      try {
        console.log(`[IdeaBird] ${label}: trying ${modelName} (attempt ${attempt}/${MODEL_ATTEMPTS})`);
        const startedAt = Date.now();
        const value = await call(modelName, attempt);
        console.log(`[IdeaBird] ${label}: success with ${modelName} in ${Date.now() - startedAt}ms`);
        return { value, model: modelName };
      } catch (caught) {
        const err = caught as GenerateError;
        console.error(`[IdeaBird] ${label}: ${modelName} attempt ${attempt} failed: ${err.status || ''} ${err.message?.substring(0, 140)}`);
        // Keep the most useful error for the user: "the model is slow" beats a later
        // fallback's "model not available for this key".
        if (!lastError?.timedOut || err.timedOut) lastError = err;

        if (err.budgetExhausted) throw err;
        if (err.timedOut || (!shouldRetry(err) && attempt === 1)) break;
      }
    }
  }

  throw lastError ?? createError(`${label} failed: no models configured.`);
}

export interface GenerationSource {
  /** Structured understanding of the screenshot, rendered for the writer model. */
  insightBrief: string;
  /** Plain-text facts used to score how concrete each post is. */
  sourceText: string;
  /** The content angle the user picked, kept separate from the facts. */
  angle?: string | null;
  /** Write Like Me style brief (never raw posts), or null for the default voice. */
  voice?: string | null;
}

// budgetMs caps the whole request (every model attempt). Serverless hosts kill the
// function at their own limit and return a non-JSON page, so the caller passes a
// budget below that limit and we return a JSON 504 ourselves instead.
export async function generateTweetsWithFallback(
  source: GenerationSource,
  { budgetMs }: { budgetMs?: number } = {}
): Promise<GenerateResult> {
  assertApiKey();
  const deadline = deadlineFrom(budgetMs);

  const { value, model } = await withModelFallback(MODEL_CANDIDATES, 'Generate', async (modelName, attempt) => {
    const raw = await requestChatCompletion({
      modelName,
      deadline,
      thinking: WRITER_THINKING,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage({ insightBrief: source.insightBrief, angle: source.angle, voice: source.voice }) },
      ],
      temperature: attempt === 1 ? 0.72 : 0.64,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
    const result = buildTweetPipeline(raw, source.sourceText);
    console.log(
      `[IdeaBird] Pipeline: ${result.diagnostics.generated} generated, ${result.diagnostics.ranked} ranked, ${result.diagnostics.selected} selected`
    );
    return result;
  });

  return { status: 'ok', ...value, model };
}

export async function requestChatCompletion({
  modelName,
  messages,
  temperature,
  maxTokens,
  deadline = Infinity,
  signal,
  thinking,
}: {
  modelName: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  deadline?: number;
  signal?: AbortSignal;
  /** false asks models that support it to skip hidden reasoning. */
  thinking?: boolean;
}): Promise<string> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < MIN_CALL_BUDGET_MS) {
    throw budgetExhaustedError();
  }

  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const reasoningEffort = useReasoningEffort(modelName) ? REASONING_EFFORT : null;
  const disableThinking =
    thinking === false && SUPPORTS_THINKING_TOGGLE.test(modelName) && !thinkingToggleUnsupported.has(modelName);

  try {
    const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as ChatCompletionPayload;
    if (!response.ok) {
      const message = payload.error?.message || payload.detail || response.statusText || 'NVIDIA NIM request failed';
      if (reasoningEffort && response.status === 400 && /reasoning/i.test(String(message))) {
        // This endpoint doesn't accept the parameter: stop sending it and retry once.
        console.warn(`[IdeaBird] ${modelName} rejected reasoning_effort; retrying without it.`);
        reasoningEffortUnsupported.add(modelName);
        return requestChatCompletion({ modelName, messages, temperature, maxTokens, deadline, signal, thinking });
      }
      if (disableThinking && response.status === 400 && /chat_template|enable_thinking/i.test(String(message))) {
        console.warn(`[IdeaBird] ${modelName} rejected the thinking toggle; retrying without it.`);
        thinkingToggleUnsupported.add(modelName);
        return requestChatCompletion({ modelName, messages, temperature, maxTokens, deadline, signal, thinking });
      }
      throw createError(message, { status: response.status });
    }

    const raw = payload.choices?.[0]?.message?.content;
    if (!raw || !raw.trim()) {
      const choice = payload.choices?.[0] ?? {};
      const reason = choice.finish_reason || 'unknown';
      // A reasoning model that exhausted max_tokens on hidden reasoning returns
      // content:null with finish_reason:'length'. That is a token-budget problem,
      // not a dead model — say so, and never mark it non-retryable.
      throw createError(
        reason === 'length'
          ? `NVIDIA NIM returned an empty response: the model spent its whole ${maxTokens}-token budget on reasoning and never wrote output. Raise NVIDIA_MAX_TOKENS.`
          : `NVIDIA NIM returned an empty response (finish_reason: ${reason}).`,
        { retryable: true, emptyResponse: true }
      );
    }

    return raw;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal?.aborted) {
        throw createError('The request was cancelled.');
      }
      if (timeoutMs < REQUEST_TIMEOUT_MS) {
        throw budgetExhaustedError();
      }

      throw createError('NVIDIA NIM is responding slowly right now. Try again in a moment.', {
        status: 504,
        retryable: true,
        timedOut: true,
      });
    }

    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

const reasoningEffortUnsupported = new Set<string>();
const thinkingToggleUnsupported = new Set<string>();

function useReasoningEffort(modelName: string): boolean {
  return Boolean(REASONING_EFFORT) && SUPPORTS_REASONING_EFFORT.test(modelName) && !reasoningEffortUnsupported.has(modelName);
}

function budgetExhaustedError(): GenerateError {
  return createError(
    'This took too long and was stopped before the server time limit. Please try again.',
    { status: 504, budgetExhausted: true }
  );
}

function shouldRetry(err: GenerateError): boolean {
  if (err.retryable) return true;
  if (err.status && [408, 429, 500, 502, 503, 504].includes(err.status)) return true;
  return /parse|json|select|empty|network|fetch|terminated|timeout/i.test(err.message || '');
}
