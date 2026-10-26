import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { config } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

// Arbitrary constant key for the advisory lock that serializes schema setup when
// several serverless instances cold-start at once.
const SCHEMA_LOCK_KEY = 48162911;

// Node's "happy eyeballs" gives each resolved address (IPv4/IPv6) only 250ms to
// connect. A database far away (e.g. Neon in us-east-2 from India) can take
// longer, so the first connection failed with ETIMEDOUT and signup returned 500.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);

// Failures while CONNECTING, before any SQL was sent, so retrying can't run a
// write twice. Errors mid-query are not retried.
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', '57P03']);

function isTransient(err: unknown): boolean {
  const e = err as { code?: string; errors?: { code?: string }[]; message?: string };
  return (
    TRANSIENT_CODES.has(e?.code ?? '') ||
    Boolean(e?.errors?.some((inner) => TRANSIENT_CODES.has(inner.code ?? ''))) ||
    /timeout exceeded when trying to connect/i.test(e?.message ?? '')
  );
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isTransient(err)) throw err;
    console.warn(`[IdeaBird] Database connection failed (${(err as { code?: string }).code ?? 'error'}); retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return run();
  }
}

// Every query in the app goes through this one function, always with bound
// parameters ($1, $2, ...). Never interpolate user input into SQL text.
export type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

let queryImpl: Promise<QueryFn> | null = null;

export function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  queryImpl ??= connect(config().databaseUrl).catch((err) => {
    queryImpl = null; // retry on the next query instead of failing forever
    throw err;
  });
  return queryImpl.then((run) => run<T>(text, params));
}

async function connect(url: string): Promise<QueryFn> {
  // `pglite:` runs an embedded Postgres (WASM) for local dev and tests, no server
  // needed: `pglite:memory` or `pglite:./.data/ideabird`. The schema is applied
  // automatically. Production uses a real Postgres URL (Neon: the pooled one).
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const location = url.slice('pglite:'.length);
    if (location !== 'memory') mkdirSync(location, { recursive: true });
    const db = new PGlite(location === 'memory' ? undefined : location);
    await db.exec(SCHEMA_SQL);
    return async <T>(text: string, params: unknown[] = []) =>
      params.length ? (await db.query<T>(text, params)).rows : (((await db.exec(text)).at(-1)?.rows ?? []) as T[]);
  }

  const pool = new pg.Pool({
    connectionString: url,
    // Serverless functions are short-lived; keep the per-instance pool small.
    max: config().onVercel ? 3 : 10,
    ssl: sslFor(url),
    connectionTimeoutMillis: 10_000,
  });
  // Lets Vercel Fluid compute close idle connections before an instance is
  // suspended, instead of leaking them (Neon's recommendation for pg on Vercel).
  if (config().onVercel) attachDatabasePool(pool);

  // Create any missing tables before the first query, so a fresh database (or a
  // skipped `npm run db:migrate`) works instead of failing with 500s.
  await withRetry(() => applySchema(process.env.DATABASE_URL_UNPOOLED || url));

  // Without params, use the simple protocol so multi-statement SQL works.
  return async <T>(text: string, params: unknown[] = []) => {
    if (params.length) return (await withRetry(() => pool.query(text, params))).rows as T[];
    const results: pg.QueryResult | pg.QueryResult[] = await withRetry(() => pool.query(text));
    return ((Array.isArray(results) ? results.at(-1)?.rows : results.rows) ?? []) as T[];
  };
}

/** Test helper: point the module at a fresh database. */
export function resetDatabaseForTests(): void {
  queryImpl = null;
}

function sslFor(url: string): pg.ClientConfig['ssl'] {
  return /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true };
}

/**
 * Applies the idempotent schema over a dedicated connection. Use the DIRECT
 * (unpooled) URL: through a transaction-mode pooler such as Neon's PgBouncer,
 * session state like locks doesn't survive between statements. The lock is
 * transaction-scoped, so it is released by COMMIT/ROLLBACK even if we crash.
 */
export async function applySchema(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
