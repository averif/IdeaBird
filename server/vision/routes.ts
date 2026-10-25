import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { config } from '../config.js';
import { sendAiError, aiBudgetMs } from '../generate/routes.js';
import type { GenerateError } from '../generateService.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { analyzeScreenshot, refineWithOcr } from './analyze.js';
import { validateImageDataUrl } from './image.js';
import { normalizeInsight, signInsight, verifyInsight } from './insight.js';

export const analyzeRouter = Router();
analyzeRouter.use(requireAuth);

export const POLICY_BLOCK_MESSAGE =
  'IdeaBird does not generate amplified versions of unverified political allegations, conspiracy claims, or health misinformation.';

/**
 * Step 1 of the pipeline: the vision model looks at the screenshot and returns
 * a structured understanding. Moderation happens in the same call, so there is
 * no separate moderation request.
 */
analyzeRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  await rateLimit({
    key: `analyze:${user.id}`,
    max: config().generateLimitPerHour * 2,
    windowSeconds: 60 * 60,
    message: 'You have reached the hourly limit for analyzing screenshots. Try again later.',
  });

  const image = validateImageDataUrl((req.body ?? {}).image);

  try {
    const analysis = await analyzeScreenshot(image, { budgetMs: aiBudgetMs() });
    if (analysis.blocked) {
      console.log('[IdeaBird] Policy block: misinformation amplification risk');
      return res.json({ status: 'policy_block', error: POLICY_BLOCK_MESSAGE });
    }

    return res.json({
      status: 'ok',
      insight: analysis.insight,
      insightToken: signInsight(user.id, analysis.insight),
      needsOcr: analysis.needsOcr,
      model: analysis.model,
    });
  } catch (err) {
    return sendAiError(res, err as GenerateError);
  }
});

/**
 * Optional step, only when the vision model flagged information it couldn't read:
 * the browser runs OCR and this merges that text in as supporting evidence.
 */
analyzeRouter.post('/refine', async (req, res) => {
  const user = currentUser(req);
  await rateLimit({ key: `refine:${user.id}`, max: config().generateLimitPerHour * 2, windowSeconds: 60 * 60 });

  const body = parseBody(
    z.object({ insight: z.unknown(), insightToken: z.string().max(200), ocrText: z.string().max(20000) }),
    req.body
  );
  const insight = normalizeInsight(body.insight);
  if (!verifyInsight(user.id, insight, body.insightToken)) {
    throw new HttpError(403, 'This analysis has expired. Upload the screenshot again.');
  }

  const ocrText = body.ocrText.trim();
  const refined = ocrText ? await refineWithOcr(insight, ocrText, { budgetMs: aiBudgetMs() }) : insight;
  res.json({ status: 'ok', insight: refined, insightToken: signInsight(user.id, refined) });
});
