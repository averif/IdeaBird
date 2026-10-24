import { createApp } from '../server/app.js';

// Every /api/* request is rewritten here (vercel.json) and handled by the same
// Express app used locally.

// 60s is the highest limit every Vercel plan allows. Reasoning models need ~30-40s for
// moderation + generation, so the old 30s limit killed requests and Vercel answered
// with a non-JSON FUNCTION_INVOCATION_TIMEOUT page.
// Vercel reads this config statically at build time: values must be literals, not
// variables ("Unhandled type: Identifier"). Keep the budget in server/generate/routes.ts in sync.
export const config = {
  maxDuration: 60,
};

export default createApp();
