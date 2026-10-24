import { Router, type Response } from 'express';
import { requireAuth, currentUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { generateTweetsWithFallback, type GenerateError } from '../generateService.js';
import { rateLimit } from '../security/rateLimit.js';

export const generateRouter = Router();

// On Vercel the function is killed at maxDuration (60s, see api/index.ts). Stop
// NVIDIA work before that so the client gets a JSON 504 instead of Vercel's page.
// Locally the default cap is 90s, so a stuck endpoint can't keep users waiting for minutes.
function generationBudgetMs(): number | undefined {
  if (config().onVercel) {
    return Math.min(Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS || 55000), 57000);
  }
  return Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS) || 90000;
}

generateRouter.post('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  // Per-user quota protects the NVIDIA key from abuse by any single account.
  await rateLimit({
    key: `generate:${user.id}`,
    max: config().generateLimitPerHour,
    windowSeconds: 60 * 60,
    message: 'You have reached the hourly generation limit. Try again later.',
  });

  const { text } = (req.body ?? {}) as { text?: unknown };

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided. Extract text from a screenshot first.' });
  }

  if (text.length > 10000) {
    return res.status(400).json({ error: 'Text is too long. Please use a shorter excerpt (max 10,000 characters).' });
  }

  try {
    const result = await generateTweetsWithFallback(text.trim(), { budgetMs: generationBudgetMs() });
    if (result.status === 'policy_block') {
      return res.json({
        status: 'policy_block',
        tweets: [],
        error:
          'IdeaBird does not generate amplified versions of unverified political allegations, conspiracy claims, or health misinformation.',
      });
    }

    const [saved] = await query<{ id: string }>(
      `INSERT INTO generations (user_id, source_text, tweets, model) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, text.trim(), JSON.stringify(result.tweets), result.model]
    );

    return res.json({ status: 'ok', id: saved?.id, tweets: result.tweets, model: result.model });
  } catch (err) {
    return sendGenerateError(res, err as GenerateError);
  }
});

function sendGenerateError(res: Response, err: GenerateError) {
  console.error('Generate error:', err.message || err);

  const status = err.status || err.httpCode;
  if (status === 401 || status === 403) {
    // Our NVIDIA key failed, not the user's session: don't answer 401, or the
    // client would think it was logged out.
    return res.status(502).json({ error: 'Invalid or missing NVIDIA API key. Add NVIDIA_API_KEY in your environment variables.' });
  }
  if (status === 429) {
    return res.status(429).json({
      error: 'NVIDIA NIM rate limit or quota was reached. Try again later or set NVIDIA_MODEL / NVIDIA_FALLBACK_MODELS to another available model.',
    });
  }
  if (status === 503) {
    return res.status(503).json({ error: 'NVIDIA NIM is currently overloaded. Try again in a few seconds.' });
  }
  if (status === 404 || status === 410) {
    // NVIDIA's message names the account; keep it in the server log only.
    return res.status(502).json({
      error: 'The configured AI model is not available for this NVIDIA API key. Set NVIDIA_MODEL / NVIDIA_FALLBACK_MODELS to a model your key can use.',
    });
  }

  return res.status(status || 500).json({
    error: err.message || 'Something went wrong generating tweets. Please try again.',
  });
}
