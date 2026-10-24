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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionPayload {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
  detail?: string;
}

interface ModerationResult {
  blocked: boolean;
  answer: string;
  error?: string;
}

export type GenerateResult =
  | { status: 'policy_block'; tweets: []; moderation: ModerationResult }
  | {
      status: 'ok';
      tweets: Tweet[];
      diagnostics: ReturnType<typeof buildTweetPipeline>['diagnostics'];
      model: string;
    };

function createError(message: string, props: Partial<GenerateError> = {}): GenerateError {
  return Object.assign(new Error(message), props);
}

const NVIDIA_BASE_URL = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || process.env.GEMINI_API_KEY;
// Fail fast: a model that hasn't answered in this time is usually stuck in a queue,
// so moving on to the next fallback model beats waiting it out.
const REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_TIMEOUT_MS || 60000);
const MODEL_ATTEMPTS = Number(process.env.NVIDIA_MODEL_ATTEMPTS || 1);
// Moderation runs alongside generation. Once the posts are ready, wait at most this
// long for its verdict before treating the check as unavailable.
const MODERATION_GRACE_MS = Number(process.env.NVIDIA_MODERATION_GRACE_MS || 3000);
// How hard reasoning models think before answering. Short posts don't need deep
// reasoning, and reasoning tokens are most of the wait. Set to "" to not send it.
const REASONING_EFFORT = process.env.NVIDIA_REASONING_EFFORT ?? 'low';
// Models known to accept the OpenAI-style `reasoning_effort` parameter.
const SUPPORTS_REASONING_EFFORT = /gpt-oss/i;
// Reasoning models (gpt-oss, nemotron *-reasoning, deepseek, kimi) spend max_tokens on
// hidden reasoning BEFORE emitting `content`. A small budget yields content:null with
// finish_reason:"length" — an empty response, not a model failure. Budget for reasoning.
const MAX_OUTPUT_TOKENS = Number(process.env.NVIDIA_MAX_TOKENS || 4096);
const MODERATION_MAX_TOKENS = Number(process.env.NVIDIA_MODERATION_MAX_TOKENS || 2048);
// Don't start a model call with less time than this left in the request budget —
// it would only be aborted mid-reasoning.
const MIN_CALL_BUDGET_MS = 5000;

const configuredModels = [
  process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b',
  ...(process.env.NVIDIA_FALLBACK_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
];

export const MODEL_CANDIDATES = [...new Set(configuredModels)];
export const NIM_CONFIG = {
  baseUrl: NVIDIA_BASE_URL,
  modelCandidates: MODEL_CANDIDATES,
};

export function assertApiKey(): void {
  if (!API_KEY) {
    throw createError('NVIDIA_API_KEY is missing. Add it to your environment variables.', { status: 401 });
  }
}

// budgetMs caps the whole request (moderation + every model attempt). Serverless hosts
// kill the function at their own limit and return a non-JSON page, so the caller passes
// a budget below that limit and we return a JSON 504 ourselves instead.
export async function generateTweetsWithFallback(
  text: string,
  { budgetMs }: { budgetMs?: number } = {}
): Promise<GenerateResult> {
  assertApiKey();

  const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
  // Lets a "blocked" moderation verdict cancel generation that's still running.
  const generationAbort = new AbortController();

  // Moderation and generation run in parallel instead of back to back, so the
  // user waits for one model call instead of two.
  let moderationSettled = false;
  const moderationPromise = classifyContentPolicy(text, deadline)
    .catch((err: GenerateError): ModerationResult => {
      // The guardrail is best-effort infrastructure, not the product. If the moderation
      // call itself dies (dead model, timeout, quota) we must not block a legitimate
      // request — log it loudly and continue.
      console.error(
        `[IdeaBird] Moderation check unavailable (${err.status || ''} ${err.message?.substring(0, 120)}) — continuing without it.`
      );
      return { blocked: false, answer: 'unavailable', error: err.message };
    })
    .then((result) => {
      moderationSettled = true;
      if (result.blocked) generationAbort.abort();
      return result;
    });

  const generationPromise = generateWithFallback(text, deadline, generationAbort.signal);
  // Don't surface a generation error (e.g. "cancelled") before moderation has spoken.
  generationPromise.catch(() => {});

  const first = await Promise.race([
    moderationPromise.then((moderation) => ({ kind: 'moderation' as const, moderation })),
    generationPromise.then(
      (result) => ({ kind: 'generation' as const, result }),
      (error: GenerateError) => ({ kind: 'generation-error' as const, error })
    ),
  ]);

  let moderation: ModerationResult;
  if (first.kind === 'moderation') {
    moderation = first.moderation;
  } else if (first.kind === 'generation-error') {
    // Generation failed outright; a block verdict would still be the better message.
    moderation = await moderationPromise;
    if (!moderation.blocked) throw first.error;
  } else {
    // Posts are ready. Give moderation a short grace period, then move on.
    const timedOut: ModerationResult = { blocked: false, answer: 'unavailable', error: 'slower than generation' };
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    moderation = await Promise.race([
      moderationPromise,
      new Promise<ModerationResult>((resolve) => {
        graceTimer = setTimeout(() => resolve(timedOut), MODERATION_GRACE_MS);
      }),
    ]);
    clearTimeout(graceTimer);
    if (!moderationSettled) {
      console.error('[IdeaBird] Moderation check unavailable (slower than generation) — continuing without it.');
    }
  }

  if (moderation.blocked) {
    console.log('[IdeaBird] Policy block: misinformation amplification risk');
    return {
      status: 'policy_block',
      tweets: [],
      moderation,
    };
  }

  return generationPromise;
}

async function generateWithFallback(text: string, deadline: number, signal: AbortSignal): Promise<GenerateResult> {
  let lastError: GenerateError | null = null;

  for (const modelName of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw createError('Generation cancelled by the content policy check.');

      try {
        console.log(`[IdeaBird] Trying model: ${modelName} (attempt ${attempt}/${MODEL_ATTEMPTS})`);

        const startedAt = Date.now();
        const raw = await requestGenerationModel(text, modelName, attempt, deadline, signal);
        const result = buildTweetPipeline(raw, text);

        console.log(
          `[IdeaBird] Pipeline: ${result.diagnostics.generated} generated, ${result.diagnostics.ranked} ranked, ${result.diagnostics.selected} selected`
        );
        console.log(`[IdeaBird] Success with ${modelName} in ${Date.now() - startedAt}ms`);

        return { status: 'ok', ...result, model: modelName };
      } catch (caught) {
        const err = caught as GenerateError;
        console.error(`[IdeaBird] ${modelName} attempt ${attempt} failed: ${err.status || ''} ${err.message?.substring(0, 140)}`);
        // Keep the most useful error for the user: "the model is slow" beats a later
        // fallback's "model not available for this key".
        if (!lastError?.timedOut || err.timedOut) lastError = err;

        if (err.budgetExhausted || signal.aborted) {
          throw err;
        }

        // A timeout means the model is slow or queued; retrying it would just wait
        // again, so go straight to the next model.
        if (err.timedOut || (!shouldRetry(err) && attempt === 1)) {
          break;
        }
      }
    }
  }

  throw lastError;
}

export async function classifyContentPolicy(text: string, deadline = Infinity): Promise<ModerationResult> {
  const modelName = MODEL_CANDIDATES[0];
  const raw = await requestChatCompletion({
    modelName,
    deadline,
    messages: [
      {
        role: 'system',
        content:
          'Does this screenshot contain unverified allegations presented as fact, conspiracy claims, or content designed to spread misinformation? Answer with exactly one word: yes or no. Do not explain.',
      },
      {
        role: 'user',
        content: `Screenshot OCR text:\n---\n${text}\n---`,
      },
    ],
    temperature: 0,
    maxTokens: MODERATION_MAX_TOKENS,
  });

  const answer = raw.trim().toLowerCase();
  return {
    blocked: /^yes\b/.test(answer),
    answer,
  };
}

async function requestGenerationModel(
  text: string,
  modelName: string,
  attempt: number,
  deadline: number,
  signal: AbortSignal
): Promise<string> {
  return requestChatCompletion({
    modelName,
    deadline,
    signal,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(text) },
    ],
    temperature: attempt === 1 ? 0.72 : 0.64,
    maxTokens: MAX_OUTPUT_TOKENS,
  });
}

async function requestChatCompletion({
  modelName,
  messages,
  temperature,
  maxTokens,
  deadline = Infinity,
  signal,
}: {
  modelName: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  deadline?: number;
  signal?: AbortSignal;
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
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as ChatCompletionPayload;
    if (!response.ok) {
      const message = payload.error?.message || payload.detail || response.statusText || 'NVIDIA NIM request failed';
      if (reasoningEffort && response.status === 400 && /reasoning/i.test(String(message))) {
        // This endpoint doesn't accept the parameter: stop sending it and retry once.
        console.warn(`[IdeaBird] ${modelName} rejected reasoning_effort; retrying without it.`);
        reasoningEffortUnsupported.add(modelName);
        return requestChatCompletion({ modelName, messages, temperature, maxTokens, deadline, signal });
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
        throw createError('Generation cancelled by the content policy check.');
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

function useReasoningEffort(modelName: string): boolean {
  return Boolean(REASONING_EFFORT) && SUPPORTS_REASONING_EFFORT.test(modelName) && !reasoningEffortUnsupported.has(modelName);
}

function budgetExhaustedError(): GenerateError {
  return createError(
    'Generation took too long and was stopped before the server time limit. Try again, or use a shorter excerpt.',
    { status: 504, budgetExhausted: true }
  );
}

function shouldRetry(err: GenerateError): boolean {
  if (err.retryable) return true;
  if (err.status && [408, 429, 500, 502, 503, 504].includes(err.status)) return true;
  return /parse|json|select|empty|network|fetch|terminated|timeout/i.test(err.message || '');
}
