import type { User } from '../types';

// The access token lives only in memory (never localStorage), so injected scripts
// can't read it from storage and it disappears with the tab. The long-lived
// refresh token is an httpOnly cookie the page can't touch at all.
let accessToken: string | null = null;
let sessionListener: (user: User | null) => void = () => {};
let refreshInFlight: Promise<User | null> | null = null;

export interface SessionResponse {
  accessToken: string;
  user: User;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function onSessionChange(listener: (user: User | null) => void) {
  sessionListener = listener;
}

export function setSession(session: SessionResponse | null) {
  accessToken = session?.accessToken ?? null;
  sessionListener(session?.user ?? null);
}

async function readError(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(res.status, data.error || `Request failed (HTTP ${res.status}).`);
}

/**
 * Trades the refresh cookie for a new access token. Refresh tokens rotate, so two
 * tabs refreshing at once would trip reuse detection; a Web Lock makes tabs take
 * turns (each then uses the cookie the previous one rotated in).
 */
export function refreshSession(): Promise<User | null> {
  refreshInFlight ??= (async () => {
    const run = async () => {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'IdeaBird' },
      });
      if (!res.ok) {
        setSession(null);
        return null;
      }
      const session = (await res.json()) as SessionResponse;
      setSession(session);
      return session.user;
    };

    try {
      return navigator.locks ? await navigator.locks.request('ideabird-refresh', run) : await run();
    } catch {
      setSession(null);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * fetch for our API: adds the bearer token and retries once after a refresh on 401.
 * Pass retry=false for login-style endpoints, where 401 means "wrong credentials".
 */
export async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const send = () => {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('X-Requested-With', 'IdeaBird');
    return fetch(path, { ...init, headers, credentials: 'same-origin' });
  };

  let res = await send();
  if (retry && res.status === 401 && (await refreshSession())) {
    res = await send();
  }
  return res;
}

/** JSON request helper that throws ApiError with the server's message. */
export async function apiJson<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await apiFetch(path, init, retry);
  if (!res.ok) throw await readError(res);
  return (res.status === 204 ? {} : await res.json()) as T;
}
