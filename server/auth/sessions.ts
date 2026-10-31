import { randomUUID } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { config, REFRESH_TOKEN_TTL_DAYS } from '../config.js';
import { query } from '../db/index.js';
import { hashToken, randomToken, signAccessToken } from './tokens.js';
import type { UserRow } from './users.js';

export const REFRESH_COOKIE = 'ib_rt';

// A rotated token presented again within this window is treated as a benign race
// (two tabs refreshing at once), not as theft.
const REUSE_GRACE_SECONDS = 10;

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true, // unreadable from JavaScript, so XSS can't exfiltrate it
    secure: config().isProduction,
    sameSite: 'strict', // never sent on cross-site requests (CSRF)
    path: '/api/auth', // only sent to the endpoints that need it
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function clientIp(req: Request): string | null {
  return req.ip?.slice(0, 64) || null;
}

/** Issues a new session: refresh token in an httpOnly cookie, access token in the body. */
export async function startSession(req: Request, res: Response, user: UserRow, familyId: string = randomUUID()) {
  const refreshToken = randomToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
    [user.id, familyId, hashToken(refreshToken), REFRESH_TOKEN_TTL_DAYS, req.get('user-agent')?.slice(0, 300) || null, clientIp(req)]
  );
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());

  return {
    accessToken: await signAccessToken({ sub: user.id, ver: user.token_version }),
    user: publicUser(user),
  };
}

type RotateResult = { ok: true; userId: string; familyId: string } | { ok: false };

/** Validates and consumes a refresh token, detecting reuse of rotated tokens. */
export async function consumeRefreshToken(token: string): Promise<RotateResult> {
  const [row] = await query<{
    id: string;
    user_id: string;
    family_id: string;
    expired: boolean;
    revoked_at: Date | null;
    revoked_recently: boolean;
  }>(
    `SELECT id, user_id, family_id, expires_at < now() AS expired, revoked_at,
            revoked_at > now() - make_interval(secs => $2) AS revoked_recently
       FROM refresh_tokens WHERE token_hash = $1`,
    [hashToken(token), REUSE_GRACE_SECONDS]
  );

  if (!row || row.expired) return { ok: false };

  if (row.revoked_at) {
    if (!row.revoked_recently) {
      // A token that was already rotated is being replayed: assume it was stolen
      // and kill every session descended from the same login.
      console.warn(`[auth] Refresh token reuse detected for user ${row.user_id}; revoking session family.`);
      await revokeFamily(row.family_id);
    }
    return { ok: false };
  }

  // Conditional update so two concurrent requests can't both consume the token.
  const consumed = await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [row.id]
  );
  if (consumed.length === 0) return { ok: false };

  return { ok: true, userId: row.user_id, familyId: row.family_id };
}

export async function revokeRefreshToken(token: string) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)]);
}

export async function revokeFamily(familyId: string) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}

/** Logs the user out everywhere: revokes refresh tokens and invalidates access tokens. */
export async function revokeAllSessions(userId: string) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await query(`UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1`, [userId]);
}

export function clearRefreshCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(REFRESH_COOKIE, options);
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.email_verified,
    hasPassword: Boolean(user.password_hash),
    googleLinked: Boolean(user.google_sub),
    plan: user.plan,
  };
}
