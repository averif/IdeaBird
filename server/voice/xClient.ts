import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// Minimal X API v2 client for Write Like Me: OAuth 2.0 (authorization code + PKCE)
// and two read-only calls. Base URLs come from env so tests can point at a fake X.

/** Read-only. offline.access gives a refresh token, so "Refresh my voice" works after 2h. */
export const X_SCOPES = ['tweet.read', 'users.read', 'offline.access'];

const apiBase = () => (process.env.X_API_BASE_URL || 'https://api.x.com').replace(/\/+$/, '');
const authorizeUrl = () => process.env.X_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize';
const REQUEST_TIMEOUT_MS = 15_000;

export type XErrorKind = 'unauthorized' | 'forbidden' | 'rate_limited' | 'invalid_grant' | 'no_credits' | 'unavailable';

/** An X API failure. Never carries tokens; `message` is for server logs only. */
export class XApiError extends Error {
  constructor(
    public kind: XErrorKind,
    message: string,
    /** For rate_limited: when X says the window resets (epoch ms). */
    public resetAt?: number
  ) {
    super(message);
  }
}

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

export interface XPost {
  id: string;
  text: string;
}

export function redirectUri(): string {
  return `${config().appUrl}/api/voice/x/callback`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function buildAuthorizeUrl(state: string, codeVerifier: string): string {
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config().xClientId,
    redirect_uri: redirectUri(),
    scope: X_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${authorizeUrl()}?${params}`;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${apiBase()}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new XApiError('unavailable', `X request failed: ${(err as Error).name}`);
  }
}

function errorFor(res: Response, what: string): XApiError {
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    return new XApiError('rate_limited', `${what}: rate limited`, Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined);
  }
  if (res.status === 401) return new XApiError('unauthorized', `${what}: 401`);
  if (res.status === 403) return new XApiError('forbidden', `${what}: 403`);
  // Pay-per-use X API: reading posts spends credits on IdeaBird's developer
  // account (reading the profile doesn't). 402 = that balance is empty.
  if (res.status === 402) return new XApiError('no_credits', `${what}: 402`);
  return new XApiError('unavailable', `${what}: HTTP ${res.status}`);
}

/** Token endpoint call. Confidential clients authenticate with Basic auth, public ones send client_id. */
async function tokenRequest(params: Record<string, string>, what: string): Promise<XTokens> {
  const { xClientId, xClientSecret } = config();
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if (xClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${xClientId}:${xClientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', xClientId);
  }

  const res = await send('/2/oauth2/token', { method: 'POST', headers, body });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok) {
    // A used, expired or revoked code / refresh token.
    if (res.status === 400 || res.status === 401) throw new XApiError('invalid_grant', `${what}: ${data.error || res.status}`);
    throw errorFor(res, what);
  }
  if (!data.access_token) throw new XApiError('unavailable', `${what}: no access token`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
  };
}

export function exchangeCode(code: string, codeVerifier: string): Promise<XTokens> {
  return tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: codeVerifier },
    'Token exchange'
  );
}

export function refreshTokens(refreshToken: string): Promise<XTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'Token refresh');
}

/** Best effort: disconnecting must succeed locally even if X is unreachable. */
export async function revokeToken(token: string): Promise<void> {
  const { xClientId, xClientSecret } = config();
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ token });
  if (xClientSecret) headers.Authorization = `Basic ${Buffer.from(`${xClientId}:${xClientSecret}`).toString('base64')}`;
  else body.set('client_id', xClientId);
  await send('/2/oauth2/revoke', { method: 'POST', headers, body }).catch(() => undefined);
}

async function getJson<T>(path: string, accessToken: string, what: string): Promise<T> {
  const res = await send(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw errorFor(res, what);
  return (await res.json()) as T;
}

export async function getMe(accessToken: string): Promise<{ id: string; username: string }> {
  const { data } = await getJson<{ data?: { id?: string; username?: string } }>('/2/users/me', accessToken, 'users/me');
  if (!data?.id || !data.username) throw new XApiError('unavailable', 'users/me: missing user');
  return { id: data.id, username: data.username };
}

export const MAX_POSTS = 80;
const MAX_PAGES = 4;

/**
 * The user's recent original posts, newest first: no reposts or replies, which
 * X excludes server-side. Pages until MAX_POSTS or the end of the timeline. Posts
 * that come back without text (deleted, withheld) are skipped.
 */
export async function fetchRecentPosts(accessToken: string, xUserId: string): Promise<XPost[]> {
  const posts: XPost[] = [];
  let next: string | undefined;

  for (let page = 0; page < MAX_PAGES && posts.length < MAX_POSTS; page += 1) {
    const params = new URLSearchParams({
      max_results: String(Math.min(100, Math.max(5, MAX_POSTS - posts.length))),
      exclude: 'retweets,replies',
    });
    if (next) params.set('pagination_token', next);

    const body = await getJson<{ data?: { id?: string; text?: string }[]; meta?: { next_token?: string } }>(
      `/2/users/${encodeURIComponent(xUserId)}/tweets?${params}`,
      accessToken,
      'users/tweets'
    );
    for (const post of body.data ?? []) {
      const text = typeof post.text === 'string' ? post.text.trim() : '';
      if (!post.id || !text || /^RT @/.test(text)) continue;
      posts.push({ id: post.id, text });
    }
    next = body.meta?.next_token;
    if (!next) break;
  }

  return posts.slice(0, MAX_POSTS);
}
