import { Router } from 'express';
import { z } from 'zod';
import { PLANS } from '../../shared/plans.js';
import { DEFAULT_TONE, INSTRUCTIONS_MAX_LENGTH, toneById } from '../../shared/writing.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import type { UserRow } from '../auth/users.js';
import { query } from '../db/index.js';
import { HttpError, parseBody } from '../http.js';

// Pro: a tone and standing writing instructions applied to every generation.

export const preferencesRouter = Router();
preferencesRouter.use(requireAuth);

const canCustomize = (user: UserRow) => (PLANS[user.plan] ?? PLANS.free).limits.customVoice;

interface PreferencesRow {
  tone: string;
  instructions: string;
}

async function load(userId: string): Promise<PreferencesRow> {
  const [row] = await query<PreferencesRow>(`SELECT tone, instructions FROM writing_preferences WHERE user_id = $1`, [userId]);
  return { tone: row?.tone && toneById(row.tone) ? row.tone : DEFAULT_TONE, instructions: row?.instructions ?? '' };
}

/** Collapses whitespace and strips control characters: it's prose, not markup. */
function cleanInstructions(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

preferencesRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  res.json({ ...(await load(user.id)), available: canCustomize(user) });
});

preferencesRouter.put('/', async (req, res) => {
  const user = currentUser(req);
  if (!canCustomize(user)) throw new HttpError(403, 'Custom tone and writing instructions are part of IdeaBird Pro.');
  const body = parseBody(
    z.object({
      tone: z.string().refine((id) => Boolean(toneById(id)), 'Choose one of the tones.'),
      instructions: z.string().max(INSTRUCTIONS_MAX_LENGTH * 2),
    }),
    req.body
  );
  const instructions = cleanInstructions(body.instructions);
  if (instructions.length > INSTRUCTIONS_MAX_LENGTH) {
    throw new HttpError(400, `Keep instructions under ${INSTRUCTIONS_MAX_LENGTH} characters.`);
  }
  await query(
    `INSERT INTO writing_preferences (user_id, tone, instructions) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET tone = EXCLUDED.tone, instructions = EXCLUDED.instructions, updated_at = now()`,
    [user.id, body.tone, instructions]
  );
  res.json({ ...(await load(user.id)), available: true });
});

/**
 * The preferences brief for this user's generation, or null when there is
 * nothing to apply (not Pro, default tone and no instructions, or load failed).
 */
export async function preferencesForGeneration(user: UserRow): Promise<string | null> {
  if (!canCustomize(user)) return null;
  try {
    const { tone, instructions } = await load(user.id);
    const toneInfo = tone !== DEFAULT_TONE ? toneById(tone) : undefined;
    const lines = [
      toneInfo && `Tone: ${toneInfo.label}. ${toneInfo.description}`,
      instructions && `Instructions from the user:\n${instructions}`,
    ].filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  } catch (err) {
    console.error('[IdeaBird] Could not load writing preferences; generating without them.', (err as Error).message);
    return null;
  }
}
