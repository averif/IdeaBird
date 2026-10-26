import 'dotenv/config';
import { applySchema } from './index.js';
import { SCHEMA_SQL } from './schema.js';

// Applies the schema up front. Idempotent; the server also does this on first use.
// Uses the direct (unpooled) connection, as schema changes should.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set.');
  process.exit(1);
}
if (url.startsWith('pglite:')) {
  console.log('Embedded PGlite applies the schema automatically; nothing to do.');
  process.exit(0);
}

await applySchema(url);
console.log(`\x1b[32mDatabase schema is up to date (${SCHEMA_SQL.match(/CREATE TABLE/g)?.length} tables checked).\x1b[0m`);
process.exit(0);
