import { generateTweetsWithFallback } from '../server/generateService.js';

// 60s is the highest limit every Vercel plan allows. Reasoning models need ~30-40s for
// moderation + generation, so the old 30s limit killed requests and Vercel answered
// with a non-JSON FUNCTION_INVOCATION_TIMEOUT page.
// Vercel reads this config statically at build time: values must be literals, not
// variables ("Unhandled type: Identifier"). Keep GENERATION_BUDGET_MS in sync.
export const config = {
  maxDuration: 60,
};

// Stop NVIDIA work before Vercel kills the function (60s), so the client gets a JSON 504.
const GENERATION_BUDGET_MS = Math.min(Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS || 55000), 57000);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
  }
  const { text } = body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided. Extract text from a screenshot first.' });
  }

  if (text.length > 10000) {
    return res.status(400).json({ error: 'Text is too long. Please use a shorter excerpt (max 10,000 characters).' });
  }

  try {
    const result = await generateTweetsWithFallback(text.trim(), { budgetMs: GENERATION_BUDGET_MS });
    if (result.status === 'policy_block') {
      return res.status(200).json({
        status: 'policy_block',
        tweets: [],
        error:
          'IdeaBird does not generate amplified versions of unverified political allegations, conspiracy claims, or health misinformation.',
      });
    }

    return res.status(200).json({ status: 'ok', tweets: result.tweets, model: result.model });
  } catch (err) {
    return sendGenerateError(res, err);
  }
}

function sendGenerateError(res, err) {
  console.error('Generate error:', err.message || err);

  const status = err.status || err.httpCode;
  if (status === 401 || status === 403) {
    return res.status(401).json({ error: 'Invalid or missing NVIDIA API key. Add NVIDIA_API_KEY in your Vercel project environment variables.' });
  }
  if (status === 429) {
    return res.status(429).json({
      error: 'NVIDIA NIM rate limit or quota was reached. Try again later or set NVIDIA_MODEL / NVIDIA_FALLBACK_MODELS to another available model.',
    });
  }
  if (status === 503) {
    return res.status(503).json({ error: 'NVIDIA NIM is currently overloaded. Try again in a few seconds.' });
  }

  return res.status(status || 500).json({
    error: err.message || 'Something went wrong generating tweets. Please try again.',
  });
}
