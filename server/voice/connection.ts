import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { refreshTokens, revokeToken, XApiError, type XTokens } from './xClient.js';

// X tokens at rest: AES-256-GCM with a key derived from JWT_SECRET, so a database
// leak alone doesn't hand out access to anyone's X account. Rotating JWT_SECRET
// makes stored tokens unreadable; users then see "needs to be refreshed".

function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', config().jwtSecret, Buffer.alloc(0), 'ideabird:x-tokens:v1', 32));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

export function decrypt(sealed: string): string | null {
  try {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface Connection {
  xUserId: string;
  username: string;
  status: 'active' | 'expired';
}

interface ConnectionRow {
  x_user_id: string;
  username: string;
  status: 'active' | 'expired';
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: Date | string;
}

export async function getConnection(userId: string): Promise<Connection | null> {
  const [row] = await query<ConnectionRow>(`SELECT x_user_id, username, status FROM x_connections WHERE user_id = $1`, [userId]);
  return row ? { xUserId: row.x_user_id, username: row.username, status: row.status } : null;
}

export async function saveConnection(userId: string, me: { id: string; username: string }, tokens: XTokens): Promise<void> {
  await query(
    `INSERT INTO x_connections (user_id, x_user_id, username, access_token_enc, refresh_token_enc, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (user_id) DO UPDATE SET
       x_user_id = EXCLUDED.x_user_id, username = EXCLUDED.username,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at, status = 'active', updated_at = now()`,
    [userId, me.id, me.username, encrypt(tokens.accessToken), tokens.refreshToken ? encrypt(tokens.refreshToken) : null, new Date(tokens.expiresAt)]
  );
}

export async function markExpired(userId: string): Promise<void> {
  await query(`UPDATE x_connections SET status = 'expired', updated_at = now() WHERE user_id = $1`, [userId]);
}

/** Thrown when the user must reconnect X (expired, revoked or unreadable tokens). */
export class ReconnectRequired extends Error {}

/**
 * A usable access token for this user, refreshing it first if it has (nearly)
 * expired. Refresh tokens are single use, so the new pair is stored right away.
 */
export async function accessTokenFor(userId: string): Promise<{ accessToken: string; xUserId: string }> {
  const [row] = await query<ConnectionRow>(
    `SELECT x_user_id, username, status, access_token_enc, refresh_token_enc, expires_at FROM x_connections WHERE user_id = $1`,
    [userId]
  );
  if (!row || row.status === 'expired') throw new ReconnectRequired();

  const accessToken = decrypt(row.access_token_enc);
  if (accessToken && new Date(row.expires_at).getTime() - Date.now() > 60_000) {
    return { accessToken, xUserId: row.x_user_id };
  }

  const refreshToken = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;
  if (!refreshToken) {
    await markExpired(userId);
    throw new ReconnectRequired();
  }
  try {
    const tokens = await refreshTokens(refreshToken);
    await saveConnection(userId, { id: row.x_user_id, username: row.username }, { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken });
    return { accessToken: tokens.accessToken, xUserId: row.x_user_id };
  } catch (err) {
    if (err instanceof XApiError && err.kind === 'invalid_grant') {
      await markExpired(userId);
      throw new ReconnectRequired();
    }
    throw err;
  }
}

/** Disconnect: revoke at X (best effort), then forget the tokens and the voice profile. */
export async function deleteConnection(userId: string): Promise<void> {
  const [row] = await query<ConnectionRow>(`SELECT access_token_enc, refresh_token_enc FROM x_connections WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM x_connections WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM voice_profiles WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM x_oauth_states WHERE user_id = $1`, [userId]);
  if (!row || !config().xClientId) return;
  const refresh = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;
  const access = decrypt(row.access_token_enc);
  await Promise.all([refresh && revokeToken(refresh), access && revokeToken(access)]);
}
