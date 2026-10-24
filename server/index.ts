import 'dotenv/config';
import { createApp } from './app.js';
import { assertApiKey, NIM_CONFIG } from './generateService.js';

const PORT = process.env.PORT || 3001;

try {
  assertApiKey();
} catch {
  console.error('\x1b[31mX NVIDIA_API_KEY is missing. Copy .env.example to .env and add your NVIDIA NIM key.\x1b[0m');
  process.exit(1);
}

let app;
try {
  app = createApp();
} catch (err) {
  console.error(`\x1b[31mX ${(err as Error).message}\x1b[0m`);
  process.exit(1);
}

// Express 5 hands listen errors (e.g. port in use) to this callback.
app.listen(PORT, (err?: Error) => {
  if (err) {
    console.error(`\x1b[31mX Could not start the API on port ${PORT}: ${err.message}\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32mIdeaBird API running on http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[36m  NVIDIA NIM endpoint: ${NIM_CONFIG.baseUrl}\x1b[0m`);
  console.log(`\x1b[36m  Models: ${NIM_CONFIG.modelCandidates.join(' -> ')} (fallback chain)\x1b[0m`);
});
