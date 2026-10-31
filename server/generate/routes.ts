import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, currentUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { generateTweetsWithFallback, type GenerateError } from '../generateService.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { insightBrief, insightToText, normalizeInsight, verifyInsight } from '../vision/insight.js';
import { voiceForGeneration } from '../voice/store.js';

export const generateRouter = Router();

// On Vercel the function is killed at maxDuration (60s, see api/index.ts). Stop
// NVIDIA work before that so the client gets a JSON 504 instead of Vercel's page.
// Locally the default cap is 90s, so a stuck endpoint can't keep users waiting for minutes.
export function aiBudgetMs(): number {
  if (config().onVercel) {
    return Math.min(Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS || 55000), 57000);
  }
  return Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS) || 90000;
}

/**
 * Step 2 of the pipeline: write posts from the screenshot insight. The insight
 * must carry the signature issued by /api/analyze, so it is exactly what the
 * vision model (and its moderation check) produced for this user.
 */
generateRouter.post('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  // Per-user quota protects the NVIDIA key from abuse by any single account.
  await rateLimit({
    key: `generate:${user.id}`,
    max: config().generateLimitPerHour,
    windowSeconds: 60 * 60,
    message: 'You have reached the hourly generation limit. Try again later.',
  });

  const body = parseBody(
    z.object({
      insight: z.unknown(),
      insightToken: z.string().max(200),
      angle: z.string().max(200).nullish(),
    }),
    req.body
  );

  const insight = normalizeInsight(body.insight);
  if (!verifyInsight(user.id, insight, body.insightToken)) {
    throw new HttpError(403, 'This analysis has expired. Upload the screenshot again.');
  }
  const angle = body.angle && insight.contentAngles.includes(body.angle) ? body.angle : null;

  // Write Like Me: the stored style profile, if on. Null (default voice) on any problem.
  const voice = await voiceForGeneration(user.id);

  try {
    const result = await generateTweetsWithFallback(
      { insightBrief: insightBrief(insight), sourceText: insightToText(insight), angle, voice },
      { budgetMs: aiBudgetMs() }
    );

    const [saved] = await query<{ id: string }>(
      `INSERT INTO generations (user_id, source_text, tweets, model) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, insightToText(insight), JSON.stringify(result.tweets), result.model]
    );

    return res.json({ status: 'ok', id: saved?.id, tweets: result.tweets, model: result.model, voice: Boolean(voice) });
  } catch (err) {
    return sendAiError(res, err as GenerateError);
  }
});

export function sendAiError(res: Response, err: GenerateError) {
  console.error('AI request error:', err.message || err);

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
      error: 'The configured AI model is not available for this NVIDIA API key. Check NVIDIA_MODEL and NVIDIA_VISION_MODEL.',
    });
  }

  if (!status && /fetch failed|ECONN|socket|network|terminated/i.test(err.message || '')) {
    // Network-level failures ("fetch failed", resets) carry no useful message.
    return res.status(502).json({ error: "IdeaBird couldn't reach the AI service. Please try again in a moment." });
  }

  return res.status(status && status >= 400 && status < 600 ? status : 500).json({
    error: err.message || 'Something went wrong. Please try again.',
  });
}
