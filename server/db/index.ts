import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

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

export function readSchema(): string {
  return readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
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
    await db.exec(readSchema());
    return async <T>(text: string, params: unknown[] = []) =>
      params.length ? (await db.query<T>(text, params)).rows : (((await db.exec(text)).at(-1)?.rows ?? []) as T[]);
  }

  const pool = new pg.Pool({
    connectionString: url,
    // Serverless functions are short-lived; keep the per-instance pool small.
    max: config().onVercel ? 3 : 10,
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
  });
  // Without params, use the simple protocol so multi-statement SQL (the schema) works.
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
