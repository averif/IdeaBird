import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { verifyAccessToken } from './tokens.js';
import { findUserById, type UserRow } from './users.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. Route handlers must scope every query to user.id. */
      user?: UserRow;
    }
  }
}

/**
 * Requires `Authorization: Bearer <access token>`. The user is reloaded from the
 * database on every request, so deleted users and tokens issued before a
 * "log out everywhere" or password reset (token_version bump) are rejected.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  const claims = match ? await verifyAccessToken(match[1]) : null;
  const user = claims ? await findUserById(claims.sub) : null;

  if (!claims || !user || user.token_version !== claims.ver) {
    throw new HttpError(401, 'Please log in to continue.', { 'WWW-Authenticate': 'Bearer' });
  }

  req.user = user;
  next();
}

export function currentUser(req: Request): UserRow {
  if (!req.user) throw new HttpError(401, 'Please log in to continue.');
  return req.user;
}

/**
 * CSRF guard for the endpoints authenticated by the refresh cookie. On top of the
 * SameSite=Strict cookie, require a custom header (which cross-site forms can't
 * send and which forces a CORS preflight for scripts) and a same-origin Origin.
 */
export function requireSameOrigin(req: Request, _res: Response, next: NextFunction) {
  if (req.get('x-requested-with') !== 'IdeaBird') {
    throw new HttpError(403, 'Request blocked.');
  }

  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // fall through to the rejection below
    }
    if (origin !== config().appOrigin && host !== req.get('host')) {
      throw new HttpError(403, 'Request blocked.');
    }
  }

  next();
}
