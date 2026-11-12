import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { refineUsageFor, releaseGeneration, releaseRefine, reserveGeneration, reserveRefine, usageFor } from '../billing/usage.js';
import { config } from '../config.js';
import { aiBudgetMs, limitReached, sendAiError } from '../generate/routes.js';
import type { GenerateError } from '../generateService.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { PLANS } from '../../shared/plans.js';
import { countWords, refinePost } from './refine.js';

export const refineRouter = Router();

/**
 * Polish a post the user wrote. On Pro it counts as one generation, like every
 * other AI call; Free has its own monthly refine allowance. Nothing is stored:
 * the post goes to the model and back.
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

  const refineLimit = plan.limits.refinesPerMonth;
  if (refineLimit === null) {
    if ((await reserveGeneration(user.id, plan.id)) === null) return limitReached(res, user, plan);
  } else if ((await reserveRefine(user.id, refineLimit)) === null) {
    const refines = await refineUsageFor(user.id, plan.id);
    const resets = new Date(refines!.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    return res.status(402).json({
      code: 'limit_reached',
      error: `You've used all ${refineLimit} free refines this month. Upgrade to Pro to refine with your ${PLANS.pro.limits.generationsPerMonth.toLocaleString('en-US')} monthly generations, or wait until ${resets}.`,
      refines,
    });
  }
  const giveBack = () => (refineLimit === null ? releaseGeneration(user.id) : releaseRefine(user.id));

  let result;
  try {
    result = await refinePost(body, { budgetMs: aiBudgetMs() });
  } catch (err) {
    await giveBack().catch(() => {});
    return sendAiError(res, err as GenerateError);
  }

  return res.json({
    status: 'ok',
    refined: result.refined,
    changes: result.changes,
    model: result.model,
    usage: await usageFor(user.id, plan.id),
    // Free only: the separate refine allowance. null on Pro.
    refines: await refineUsageFor(user.id, plan.id),
  });
});
