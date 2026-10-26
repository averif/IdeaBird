import { createHmac, randomInt } from 'node:crypto';
import { config, OTP_TTL_MINUTES, RESET_TOKEN_TTL_MINUTES } from '../config.js';
import { query } from '../db/index.js';
import { sendMail } from '../mail.js';
import { hashToken, randomToken } from './tokens.js';
import type { UserRow } from './users.js';

type Purpose = 'verify' | 'reset';

async function store(userId: string, purpose: Purpose, tokenHash: string, ttlMinutes: number): Promise<void> {
  // Only the newest code or link of each kind works.
  await query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, purpose, tokenHash, ttlMinutes]
  );
}

// --- Email verification: 6-digit one-time code --------------------------------
// A 6-digit code has little entropy, so it is stored as an HMAC keyed by the
// server secret and bound to the user (a leaked table can't be brute-forced
// offline), and wrong guesses are capped by the caller.

function hashOtp(userId: string, code: string): string {
  return createHmac('sha256', config().jwtSecret).update(`otp:${userId}:${code}`).digest('hex');
}

export async function sendVerificationCode(user: UserRow): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await store(user.id, 'verify', hashOtp(user.id, code), OTP_TTL_MINUTES);
  await sendMail({
    to: user.email,
    subject: `${code} is your IdeaBird verification code`,
    text: `Your IdeaBird verification code is:\n\n${code}\n\nIt expires in ${OTP_TTL_MINUTES} minutes. If you didn't sign up for IdeaBird, ignore this email.`,
  });
}

/** Atomically consumes a matching, unexpired code. Returns false if it doesn't match. */
export async function consumeVerificationCode(userId: string, code: string): Promise<boolean> {
  const rows = await query(
    `UPDATE email_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = 'verify' AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING id`,
    [userId, hashOtp(userId, code)]
  );
  return rows.length > 0;
}

/** Invalidates any outstanding code (e.g. after too many wrong guesses). */
export async function revokeVerificationCodes(userId: string): Promise<void> {
  await query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'verify' AND used_at IS NULL`, [userId]);
}

// --- Password reset: single-use link -------------------------------------------

/** Atomically marks a reset token used and returns its user id, or null if invalid/expired/used. */
export async function consumeResetToken(token: string): Promise<string | null> {
  const [row] = await query<{ user_id: string }>(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)]
  );
  return row?.user_id ?? null;
}

// Links point at APP_URL from config, never at the request's Host header, so an
// attacker can't get us to email a victim a reset link to their own domain.
export async function sendPasswordResetEmail(user: UserRow) {
  const token = randomToken();
  await store(user.id, 'reset', hashToken(token), RESET_TOKEN_TTL_MINUTES);
  await sendMail({
    to: user.email,
    subject: 'Reset your IdeaBird password',
    text: `Someone asked to reset the password for your IdeaBird account.\n\n${config().appUrl}/?reset=${token}\n\nThis link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and works once. If it wasn't you, ignore this email; your password won't change.`,
  });
}
