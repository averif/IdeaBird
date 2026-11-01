import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { releaseGeneration, reserveGeneration, usageFor } from '../billing/usage.js';
import { config } from '../config.js';
import { aiBudgetMs, limitReached, sendAiError } from '../generate/routes.js';
import type { GenerateError } from '../generateService.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { PLANS } from '../../shared/plans.js';
import { countWords, refinePost } from './refine.js';

export const refineRouter = Router();

/**
 * Pro: polish a post the user wrote. Counts as one generation, like every other
 * AI call. Nothing is stored: the post goes to the model and back.
 */
refineRouter.post('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const plan = PLANS[user.plan] ?? PLANS.free;
  if (!plan.limits.refine) {
    return res.status(403).json({ code: 'pro_required', error: 'Refine is part of IdeaBird Pro.' });
  }
  await rateLimit({
    key: `generate:${user.id}`,
    max: config().generateLimitPerHour,
    windowSeconds: 60 * 60,
    message: 'You have reached the hourly generation limit. Try again later.',
  });

  const body = parseBody(
    z.object({
      // LinkedIn's own limit is 3,000 characters.
      text: z.string().trim().min(1).max(3000),
      platform: z.enum(['x', 'linkedin']).default('x'),
    }),
    req.body
  );
  if (countWords(body.text) < 3) throw new HttpError(400, 'Paste a post of at least a few words to refine.');

  if ((await reserveGeneration(user.id, plan.id)) === null) return limitReached(res, user, plan);

  let result;
  try {
    result = await refinePost(body, { budgetMs: aiBudgetMs() });
  } catch (err) {
    await releaseGeneration(user.id).catch(() => {});
    return sendAiError(res, err as GenerateError);
  }

  return res.json({
    status: 'ok',
    refined: result.refined,
    changes: result.changes,
    model: result.model,
    usage: await usageFor(user.id, plan.id),
  });
});
