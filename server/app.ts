import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { billingRouter } from './billing/routes.js';
import { config, ConfigError } from './config.js';
import { generateRouter } from './generate/routes.js';
import { historyRouter } from './history/routes.js';
import { preferencesRouter } from './preferences/routes.js';
import { refineRouter } from './refine/routes.js';
import { analyzeRouter } from './vision/routes.js';
import { voiceRouter } from './voice/routes.js';
import { errorHandler } from './http.js';

// One Express app serves the API both locally (server/index.ts) and on Vercel
// (api/index.ts), so every route has a single implementation.
export function createApp() {
  const app = express();

  // Missing or invalid settings must not crash the function at import time: on
  // Vercel that surfaces only as an opaque FUNCTION_INVOCATION_FAILED page. Answer
  // every API call with a clear JSON error instead (setting names only, no values).
  try {
    config();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : 'Server configuration is invalid.';
    console.error(`[IdeaBird] ${message}`);
    app.use('/api', (_req, res) => {
      res.status(503).set('Cache-Control', 'no-store').json({ error: `IdeaBird isn't fully set up on the server. ${message}` });
    });
    return app;
  }

  // Vercel's edge sets X-Forwarded-For, so req.ip is the real client there.
  // Locally there's no proxy we control, so the header must not be trusted.
  app.set('trust proxy', config().onVercel ? true : 'loopback');

  app.use(
    helmet({
      // The API only returns JSON; the page's CSP lives in vercel.json.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    })
  );
  app.use((_req, res, next) => {
    // Responses may contain personal data: never cache them.
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Screenshots are sent as base64 to /api/analyze only; everything else stays tiny.
  // Dodo webhook signatures are over the exact bytes sent, so that route gets the raw body.
  app.use('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/analyze', express.json({ limit: '4.5mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // No CORS middleware on purpose: the client is same-origin (Vercel, or the
  // Vite proxy locally), so browsers block every cross-origin API call.

  app.use('/api/auth', authRouter);
  app.use('/api/analyze', analyzeRouter);
  app.use('/api/generate', generateRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/refine', refineRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use(errorHandler);

  return app;
}
