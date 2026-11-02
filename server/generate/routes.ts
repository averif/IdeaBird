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
import { preferencesForGeneration } from '../preferences/routes.js';
import { PLANS, type Plan } from '../../shared/plans.js';
import type { UserRow } from '../auth/users.js';
import { expandToThread, THREAD_STYLE } from './thread.js';
import { releaseGeneration, reserveGeneration, usageFor } from '../billing/usage.js';

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

  // Plan allowance (shared/plans.ts): claimed before the AI call, given back if it fails.
  const plan = PLANS[user.plan] ?? PLANS.free;
  if ((await reserveGeneration(user.id, plan.id)) === null) return limitReached(res, user, plan);

  // Write Like Me (Pro): the stored style profile, if on. Null (default voice) on any problem.
  const voice = config().writeLikeMe && plan.limits.writeLikeMe ? await voiceForGeneration(user.id) : null;
  // Pro: tone and standing instructions. Null when not Pro or nothing is set.
  const preferences = await preferencesForGeneration(user);

  let result;
  try {
    result = await generateTweetsWithFallback(
      { insightBrief: insightBrief(insight), sourceText: insightToText(insight), angle, voice, preferences },
      { budgetMs: aiBudgetMs() }
    );
  } catch (err) {
    await releaseGeneration(user.id).catch(() => {});
    return sendAiError(res, err as GenerateError);
  }

  // Free gets the single default post; Pro gets every variation.
  const tweets = result.tweets.slice(0, plan.limits.draftsPerGeneration);

  // Only plans with history keep generations.
  const [saved] = plan.limits.history
    ? await query<{ id: string }>(
        `INSERT INTO generations (user_id, source_text, tweets, model) VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.id, insightToText(insight), JSON.stringify(tweets), result.model]
      )
    : [];

  return res.json({
    status: 'ok',
    id: saved?.id,
    tweets,
    model: result.model,
    voice: Boolean(voice),
    plan: plan.id,
    usage: await usageFor(user.id, plan.id),
  });
});

/** 402 when this month's generations are used up. */
export async function limitReached(res: Response, user: UserRow, plan: Plan) {
  const usage = await usageFor(user.id, plan.id);
  const resets = new Date(usage.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return res.status(402).json({
    code: 'limit_reached',
    error:
      plan.id === 'free'
        ? `You've used all ${usage.limit} free generations this month. Upgrade to Pro for ${PLANS.pro.limits.generationsPerMonth.toLocaleString('en-US')} a month, or wait until ${resets}.`
        : `You've used all ${usage.limit.toLocaleString('en-US')} generations this month. Your allowance resets on ${resets}.`,
    usage,
  });
}

/**
 * Pro: expand one post into a full X thread. Grounded in the same signed
 * insight as the original generation, so it can only use the screenshot's
 * facts. Counts as one generation; added to the saved generation if given.
 */
generateRouter.post('/thread', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const plan = PLANS[user.plan] ?? PLANS.free;
  if (!plan.limits.threadExpansion) {
    throw new HttpError(403, 'Thread expansion is part of IdeaBird Pro.');
  }
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
      post: z.string().trim().min(1).max(3000),
      generationId: z.uuid().nullish(),
    }),
    req.body
  );
  const insight = normalizeInsight(body.insight);
  if (!verifyInsight(user.id, insight, body.insightToken)) {
    throw new HttpError(403, 'This analysis has expired. Upload the screenshot again.');
  }

  if ((await reserveGeneration(user.id, plan.id)) === null) return limitReached(res, user, plan);

  const voice = config().writeLikeMe && plan.limits.writeLikeMe ? await voiceForGeneration(user.id) : null;
  const preferences = await preferencesForGeneration(user);

  let thread;
  try {
    thread = await expandToThread({ insightBrief: insightBrief(insight), post: body.post, preferences, voice }, { budgetMs: aiBudgetMs() });
  } catch (err) {
    await releaseGeneration(user.id).catch(() => {});
    return sendAiError(res, err as GenerateError);
  }

  const tweet = { style: THREAD_STYLE, tweet: thread.tweet };
  // Keep it with the original drafts in History (scoped to this user's own row).
  if (body.generationId && plan.limits.history) {
    await query(`UPDATE generations SET tweets = tweets || $3::jsonb WHERE id = $1 AND user_id = $2`, [
      body.generationId,
      user.id,
      JSON.stringify([tweet]),
    ]);
  }

  return res.json({ status: 'ok', tweet, model: thread.model, usage: await usageFor(user.id, plan.id) });
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
