import 'dotenv/config';
import { query, readSchema } from './index.js';

// Applies schema.sql to DATABASE_URL. Idempotent, so it is safe to run on every deploy.
await query(readSchema());
console.log('\x1b[32mDatabase schema is up to date.\x1b[0m');
process.exit(0);
