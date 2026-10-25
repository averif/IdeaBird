import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

// Arbitrary constant key for the Postgres advisory lock that serializes schema
// setup when several serverless instances cold-start at once.
const SCHEMA_LOCK_KEY = 48162911;

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
  // automatically. Production uses a real Postgres URL (Neon).
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
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
  });

  // Create any missing tables before the first query, so a fresh database (or a
  // skipped `npm run db:migrate`) works instead of failing with 500s.
  await applySchema(pool);

  // Without params, use the simple protocol so multi-statement SQL works.
  return async <T>(text: string, params: unknown[] = []) => {
    if (params.length) return (await pool.query(text, params)).rows as T[];
    const results: pg.QueryResult | pg.QueryResult[] = await pool.query(text);
    return ((Array.isArray(results) ? results.at(-1)?.rows : results.rows) ?? []) as T[];
  };
}

/** Test helper: point the module at a fresh database. */
export function resetDatabaseForTests(): void {
  queryImpl = null;
}

async function applySchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await client.query(SCHEMA_SQL);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
