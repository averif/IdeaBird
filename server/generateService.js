import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { buildTweetPipeline } from './tweetPipeline.js';

const NVIDIA_BASE_URL = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || process.env.GEMINI_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_TIMEOUT_MS || 90000);
const MODEL_ATTEMPTS = Number(process.env.NVIDIA_MODEL_ATTEMPTS || 1);
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

export function assertApiKey() {
  if (!API_KEY) {
    const error = new Error('NVIDIA_API_KEY is missing. Add it to your environment variables.');
    error.status = 401;
    throw error;
  }
}

// budgetMs caps the whole request (moderation + every model attempt). Serverless hosts
// kill the function at their own limit and return a non-JSON page, so the caller passes
// a budget below that limit and we return a JSON 504 ourselves instead.
export async function generateTweetsWithFallback(text, { budgetMs } = {}) {
  assertApiKey();

  const deadline = budgetMs ? Date.now() + budgetMs : Infinity;

  const moderation = await classifyContentPolicy(text, deadline).catch((err) => {
    // The guardrail is best-effort infrastructure, not the product. If the moderation
    // call itself dies (dead model, timeout, quota) we must not block a legitimate
    // request — log it loudly and continue.
    console.error(
      `[IdeaBird] Moderation check unavailable (${err.status || ''} ${err.message?.substring(0, 120)}) — continuing without it.`
    );
    return { blocked: false, answer: 'unavailable', error: err.message };
  });
  if (moderation.blocked) {
    console.log('[IdeaBird] Policy block: misinformation amplification risk');
    return {
      status: 'policy_block',
      tweets: [],
      moderation,
    };
  }

  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt += 1) {
      try {
        console.log(`[IdeaBird] Trying model: ${modelName} (attempt ${attempt}/${MODEL_ATTEMPTS})`);

        const raw = await requestGenerationModel(text, modelName, attempt, deadline);
        const result = buildTweetPipeline(raw, text);

        console.log(
          `[IdeaBird] Pipeline: ${result.diagnostics.generated} generated, ${result.diagnostics.ranked} ranked, ${result.diagnostics.selected} selected`
        );
        console.log(`[IdeaBird] Success with ${modelName}`);

        return { status: 'ok', ...result, model: modelName };
      } catch (err) {
        console.error(`[IdeaBird] ${modelName} attempt ${attempt} failed: ${err.status || ''} ${err.message?.substring(0, 140)}`);
        lastError = err;

        if (err.budgetExhausted) {
          throw err;
        }

        if (!shouldRetry(err) && attempt === 1) {
          break;
        }
      }
    }
  }

  throw lastError;
}

export async function classifyContentPolicy(text, deadline = Infinity) {
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

async function requestGenerationModel(text, modelName, attempt, deadline) {
  return requestChatCompletion({
    modelName,
    deadline,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(text) },
    ],
    temperature: attempt === 1 ? 0.72 : 0.64,
    maxTokens: MAX_OUTPUT_TOKENS,
  });
}

async function requestChatCompletion({ modelName, messages, temperature, maxTokens, deadline = Infinity }) {
  const remainingMs = deadline - Date.now();
  if (remainingMs < MIN_CALL_BUDGET_MS) {
    throw budgetExhaustedError();
  }

  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || payload.detail || response.statusText || 'NVIDIA NIM request failed';
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const raw = payload.choices?.[0]?.message?.content;
    if (!raw || !raw.trim()) {
      const choice = payload.choices?.[0] || {};
      const reason = choice.finish_reason || 'unknown';
      // A reasoning model that exhausted max_tokens on hidden reasoning returns
      // content:null with finish_reason:'length'. That is a token-budget problem,
      // not a dead model — say so, and never mark it non-retryable.
      const error = new Error(
        reason === 'length'
          ? `NVIDIA NIM returned an empty response: the model spent its whole ${maxTokens}-token budget on reasoning and never wrote output. Raise NVIDIA_MAX_TOKENS.`
          : `NVIDIA NIM returned an empty response (finish_reason: ${reason}).`
      );
      error.retryable = true;
      error.emptyResponse = true;
      throw error;
    }

    return raw;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (timeoutMs < REQUEST_TIMEOUT_MS) {
        throw budgetExhaustedError();
      }

      const timeoutError = new Error('NVIDIA NIM timed out. Try again in a few seconds.');
      timeoutError.status = 504;
      timeoutError.retryable = true;
      throw timeoutError;
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function budgetExhaustedError() {
  const error = new Error('Generation took too long and was stopped before the server time limit. Try again, or use a shorter excerpt.');
  error.status = 504;
  error.budgetExhausted = true;
  return error;
}

function shouldRetry(err) {
  if (err.retryable) return true;
  if ([408, 429, 500, 502, 503, 504].includes(err.status)) return true;
  return /parse|json|select|empty|network|fetch|terminated|timeout/i.test(err.message || '');
}
