import { config, RESET_TOKEN_TTL_MINUTES, VERIFY_TOKEN_TTL_HOURS } from '../config.js';
import { query } from '../db/index.js';
import { sendMail } from '../mail.js';
import { hashToken, randomToken } from './tokens.js';
import type { UserRow } from './users.js';

type Purpose = 'verify' | 'reset';

async function issue(userId: string, purpose: Purpose, ttlMinutes: number): Promise<string> {
  // Only the newest link of each kind works.
  await query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);

  const token = randomToken();
  await query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, purpose, hashToken(token), ttlMinutes]
  );
  return token;
}

/** Atomically marks a token used and returns its user id, or null if invalid/expired/used. */
export async function consumeEmailToken(token: string, purpose: Purpose): Promise<string | null> {
  const [row] = await query<{ user_id: string }>(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token), purpose]
  );
  return row?.user_id ?? null;
}

// Links point at APP_URL from config, never at the request's Host header, so an
// attacker can't get us to email a victim a reset link to their own domain.
export async function sendVerificationEmail(user: UserRow) {
  const token = await issue(user.id, 'verify', VERIFY_TOKEN_TTL_HOURS * 60);
  await sendMail({
    to: user.email,
    subject: 'Verify your IdeaBird email',
    text: `Confirm your email address for IdeaBird:\n\n${config().appUrl}/?verify=${token}\n\nThis link expires in ${VERIFY_TOKEN_TTL_HOURS} hours. If you didn't sign up, ignore this email.`,
  });
}

export async function sendPasswordResetEmail(user: UserRow) {
  const token = await issue(user.id, 'reset', RESET_TOKEN_TTL_MINUTES);
  await sendMail({
    to: user.email,
    subject: 'Reset your IdeaBird password',
    text: `Someone asked to reset the password for your IdeaBird account.\n\n${config().appUrl}/?reset=${token}\n\nThis link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and works once. If it wasn't you, ignore this email; your password won't change.`,
  });
}
