import { query } from '../db/index.js';
import { HttpError } from '../http.js';

// Fixed-window counters kept in Postgres, so limits hold across every serverless
// instance (in-memory counters reset on each cold start).

interface Limit {
  /** Distinct bucket, e.g. `login:ip:1.2.3.4`. */
  key: string;
  max: number;
  windowSeconds: number;
  message?: string;
}

export async function rateLimit({ key, max, windowSeconds, message }: Limit): Promise<void> {
  const [row] = await query<{ count: number; retry_after: number }>(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       count    = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE rate_limits.reset_at END
     RETURNING count, CEIL(EXTRACT(EPOCH FROM (reset_at - now())))::int AS retry_after`,
    [key, windowSeconds]
  );

  // Opportunistic cleanup of expired windows.
  if (Math.random() < 0.01) {
    query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 hour'`).catch(() => {});
  }

  if (row && row.count > max) {
    throw new HttpError(429, message || 'Too many requests. Please wait a bit and try again.', {
      'Retry-After': String(Math.max(1, row.retry_after)),
    });
  }
}

/** Throws 429 if `key` has already reached `max` in its current window. Doesn't count. */
export async function assertUnderLimit(key: string, max: number, message: string): Promise<void> {
  const [row] = await query<{ count: number; retry_after: number }>(
    `SELECT count, CEIL(EXTRACT(EPOCH FROM (reset_at - now())))::int AS retry_after
       FROM rate_limits WHERE key = $1 AND reset_at > now()`,
    [key]
  );
  if (row && row.count >= max) {
    throw new HttpError(429, message, { 'Retry-After': String(Math.max(1, row.retry_after)) });
  }
}

/** Counts one event against `key` without throwing (e.g. a failed login). */
export async function recordHit(key: string, windowSeconds: number): Promise<void> {
  await rateLimit({ key, max: Number.MAX_SAFE_INTEGER, windowSeconds });
}

export async function clearLimit(key: string): Promise<void> {
  await query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
}
