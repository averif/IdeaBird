import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { config } from '../config.js';
import { aiBudgetMs, sendAiError } from '../generate/routes.js';
import type { GenerateError } from '../generateService.js';
import { parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { POLICY_BLOCK_MESSAGE } from '../vision/routes.js';
import { signInsight } from '../vision/insight.js';
import { analyzeLinkContent } from './analyze.js';
import { extractLink } from './extract.js';

export const linkRouter = Router();

/**
 * Step 1 for links (the core flow): read the page, video transcript or thread,
 * then return a signed insight. From here it's the same pipeline as a
 * screenshot: /api/generate writes the posts and counts the generation.
 * Nothing is stored.
 */
linkRouter.post('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  // Shares the screenshot analysis bucket: one hourly limit for "read a source".
  await rateLimit({
    key: `analyze:${user.id}`,
    max: config().generateLimitPerHour * 2,
    windowSeconds: 60 * 60,
    message: 'You have reached the hourly limit for reading links and screenshots. Try again later.',
  });

  const { url } = parseBody(z.object({ url: z.string().trim().min(4, 'Paste a link first.').max(2000) }), req.body);

  const startedAt = Date.now();
  // Fetch errors are HttpErrors with a readable message; the error handler sends them.
  const content = await extractLink(url);

  try {
    const analysis = await analyzeLinkContent(content, { budgetMs: aiBudgetMs() - (Date.now() - startedAt) });
    if (analysis.blocked) {
      console.log('[IdeaBird] Policy block (link): misinformation amplification risk');
      return res.json({ status: 'policy_block', error: POLICY_BLOCK_MESSAGE });
    }
    return res.json({
      status: 'ok',
      insight: analysis.insight,
      insightToken: signInsight(user.id, analysis.insight),
      model: analysis.model,
    });
  } catch (err) {
    return sendAiError(res, err as GenerateError);
  }
});
