import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config, LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from '../config.js';
import { query } from '../db/index.js';
import { HttpError, parseBody } from '../http.js';
import { assertUnderLimit, clearLimit, rateLimit, recordHit } from '../security/rateLimit.js';
import { consumeEmailToken, sendPasswordResetEmail, sendVerificationEmail } from './emailTokens.js';
import { verifyGoogleIdToken } from './google.js';
import { currentUser, requireAuth, requireSameOrigin } from './middleware.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import {
  clearRefreshCookie,
  consumeRefreshToken,
  publicUser,
  REFRESH_COOKIE,
  revokeAllSessions,
  revokeRefreshToken,
  startSession,
} from './sessions.js';
import { createUser, findUserByEmail, findUserByGoogleSub, findUserById, normalizeEmail } from './users.js';

export const authRouter = Router();

const HOUR = 60 * 60;
const email = z.email('Enter a valid email address.').max(254, 'Email is too long.');
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.');
const token = z.string().min(20).max(200);

const LOGIN_FAILED = 'Incorrect email or password.';
const LOCKED_OUT = `Too many failed login attempts. Try again in ${LOCKOUT_MINUTES} minutes, or reset your password.`;

function ipKey(req: Request) {
  return req.ip || 'unknown';
}

// Public settings the client needs (the Google client ID is not a secret).
authRouter.get('/config', (_req, res) => {
  res.json({ googleClientId: config().googleClientId || null });
});

authRouter.post('/signup', async (req, res) => {
  await rateLimit({ key: `signup:ip:${ipKey(req)}`, max: 10, windowSeconds: HOUR, message: 'Too many sign-ups from this network. Try again later.' });

  const body = parseBody(
    z.object({ email, password, name: z.string().trim().max(120).optional() }),
    req.body
  );
  if (normalizeEmail(body.password) === normalizeEmail(body.email)) {
    throw new HttpError(400, "Password can't be the same as your email.");
  }

  const user = await createUser({
    email: body.email,
    name: body.name || null,
    passwordHash: await hashPassword(body.password),
  });
  if (!user) {
    throw new HttpError(409, 'An account with this email already exists. Log in instead.');
  }

  await sendVerificationEmail(user);
  res.status(201).json(await startSession(req, res, user));
});

authRouter.post('/login', async (req, res) => {
  await rateLimit({ key: `login:ip:${ipKey(req)}`, max: 30, windowSeconds: 15 * 60, message: 'Too many login attempts. Please wait a few minutes.' });

  const body = parseBody(z.object({ email, password: z.string().max(128) }), req.body);
  const lockKey = `login-fail:${normalizeEmail(body.email)}`;
  await assertUnderLimit(lockKey, MAX_FAILED_LOGINS, LOCKED_OUT);

  const user = await findUserByEmail(body.email);
  // Always run one scrypt verification so response time doesn't reveal whether
  // the account exists or has a password.
  const valid = await verifyPassword(body.password, user?.password_hash || (await getDummyHash()));

  if (!user || !user.password_hash || !valid) {
    await recordHit(lockKey, LOCKOUT_MINUTES * 60);
    throw new HttpError(401, LOGIN_FAILED);
  }

  await clearLimit(lockKey);
  res.json(await startSession(req, res, user));
});

authRouter.post('/google', async (req, res) => {
  await rateLimit({ key: `google:ip:${ipKey(req)}`, max: 30, windowSeconds: 15 * 60 });

  const { credential } = parseBody(z.object({ credential: z.string().min(1).max(4096) }), req.body);
  const profile = await verifyGoogleIdToken(credential);

  let user = await findUserByGoogleSub(profile.sub);

  if (!user) {
    const existing = await findUserByEmail(profile.email);
    if (existing) {
      // Link Google to the existing account. If its email was never verified,
      // whoever registered it may not own the inbox (pre-account-takeover), so
      // drop their password and sessions; Google has proven ownership.
      if (!existing.email_verified) {
        await revokeAllSessions(existing.id);
      }
      await query(
        `UPDATE users
            SET google_sub = $2,
                email_verified = true,
                password_hash = CASE WHEN email_verified THEN password_hash ELSE NULL END,
                name = COALESCE(name, $3),
                updated_at = now()
          WHERE id = $1`,
        [existing.id, profile.sub, profile.name]
      );
      user = await findUserById(existing.id);
    } else {
      user = await createUser({ email: profile.email, name: profile.name, googleSub: profile.sub, emailVerified: true });
    }
  }

  if (!user) throw new HttpError(409, 'Could not sign in with Google. Please try again.');
  res.json(await startSession(req, res, user));
});

authRouter.post('/refresh', requireSameOrigin, async (req: Request, res: Response) => {
  await rateLimit({ key: `refresh:ip:${ipKey(req)}`, max: 120, windowSeconds: 15 * 60 });

  const presented = req.cookies?.[REFRESH_COOKIE];
  const result = typeof presented === 'string' ? await consumeRefreshToken(presented) : { ok: false as const };
  const user = result.ok ? await findUserById(result.userId) : null;

  if (!result.ok || !user) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Your session has ended. Please log in again.');
  }

  res.json(await startSession(req, res, user, result.familyId));
});

authRouter.post('/logout', requireSameOrigin, async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (typeof presented === 'string') await revokeRefreshToken(presented);
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(currentUser(req).id);
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});

authRouter.post('/verify-email', async (req, res) => {
  await rateLimit({ key: `verify:ip:${ipKey(req)}`, max: 20, windowSeconds: HOUR });

  const body = parseBody(z.object({ token }), req.body);
  const userId = await consumeEmailToken(body.token, 'verify');
  if (!userId) throw new HttpError(400, 'This verification link is invalid or has expired.');

  await query(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, [userId]);
  res.json({ ok: true });
});

authRouter.post('/resend-verification', requireAuth, async (req, res) => {
  const user = currentUser(req);
  await rateLimit({ key: `resend-verify:${user.id}`, max: 3, windowSeconds: HOUR, message: 'Verification email already sent. Check your inbox.' });

  if (!user.email_verified) await sendVerificationEmail(user);
  res.json({ ok: true });
});

authRouter.post('/forgot-password', async (req, res) => {
  await rateLimit({ key: `forgot:ip:${ipKey(req)}`, max: 10, windowSeconds: HOUR });

  const body = parseBody(z.object({ email }), req.body);
  await rateLimit({ key: `forgot:email:${normalizeEmail(body.email)}`, max: 3, windowSeconds: HOUR });

  const user = await findUserByEmail(body.email);
  if (user) await sendPasswordResetEmail(user);

  // Same answer either way: this endpoint must not reveal who has an account.
  res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
});

authRouter.post('/reset-password', async (req, res) => {
  await rateLimit({ key: `reset:ip:${ipKey(req)}`, max: 20, windowSeconds: HOUR });

  const body = parseBody(z.object({ token, password }), req.body);
  const userId = await consumeEmailToken(body.token, 'reset');
  if (!userId) throw new HttpError(400, 'This reset link is invalid or has expired. Request a new one.');

  // Resetting proves inbox ownership, so the email counts as verified. Every
  // existing session is revoked in case the old password was compromised.
  await query(
    `UPDATE users SET password_hash = $2, email_verified = true, updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(body.password)]
  );
  await revokeAllSessions(userId);

  const user = await findUserById(userId);
  if (!user) throw new HttpError(400, 'This reset link is invalid or has expired. Request a new one.');
  await clearLimit(`login-fail:${user.email}`);

  res.json(await startSession(req, res, user));
});
