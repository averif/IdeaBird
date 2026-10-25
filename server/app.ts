import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { config } from './config.js';
import { generateRouter } from './generate/routes.js';
import { historyRouter } from './history/routes.js';
import { analyzeRouter } from './vision/routes.js';
import { errorHandler } from './http.js';

// One Express app serves the API both locally (server/index.ts) and on Vercel
// (api/index.ts), so every route has a single implementation.
export function createApp() {
  config(); // fail fast on missing secrets

  const app = express();

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
  app.use('/api/analyze', express.json({ limit: '4.5mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // No CORS middleware on purpose: the client is same-origin (Vercel, or the
  // Vite proxy locally), so browsers block every cross-origin API call.

  app.use('/api/auth', authRouter);
  app.use('/api/analyze', analyzeRouter);
  app.use('/api/generate', generateRouter);
  app.use('/api/history', historyRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use(errorHandler);

  return app;
}
