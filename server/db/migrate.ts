import 'dotenv/config';
import { query } from './index.js';
import { SCHEMA_SQL } from './schema.js';

// Applies the schema to DATABASE_URL. Idempotent. The server also does this
// automatically on first use; this script is for setting up a database up front.
await query(SCHEMA_SQL);
console.log('\x1b[32mDatabase schema is up to date.\x1b[0m');
process.exit(0);
