import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config, LOCKOUT_MINUTES, MAX_FAILED_LOGINS, MAX_OTP_ATTEMPTS, OTP_TTL_MINUTES } from '../config.js';
import { query } from '../db/index.js';
import { HttpError, parseBody } from '../http.js';
import { MailError, mailDelivery } from '../mail.js';
import { assertUnderLimit, clearLimit, rateLimit, recordHit } from '../security/rateLimit.js';
import {
  consumeResetToken,
  consumeVerificationCode,
  revokeVerificationCodes,
  sendPasswordResetEmail,
  sendVerificationCode,
} from './emailTokens.js';
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
import { createUser, findUserByEmail, findUserByGoogleSub, findUserById, normalizeEmail, type UserRow } from './users.js';

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

const BAD_CODE = 'That code is incorrect or has expired.';

/**
 * Emails a fresh 6-digit code. Rate limited per address so the endpoint can't
 * be used to flood someone's inbox.
 */
async function sendCode(user: UserRow) {
  await rateLimit({
    key: `otp-send:${user.email}`,
    max: 5,
    windowSeconds: HOUR,
    message: 'Too many codes requested for this email. Try again later.',
  });
  try {
    await sendVerificationCode(user);
  } catch (err) {
    if (err instanceof MailError) {
      throw new HttpError(502, "We couldn't send the verification email right now. Please try again in a minute.");
    }
    throw err;
  }
}

/** Response telling the client to show the code step. No session is issued yet. */
function verificationRequired(res: Response, user: UserRow, status = 200) {
  res.status(status).json({
    status: 'verification_required',
    email: user.email,
    // Local development without an email provider: the code is in the API logs.
    ...(mailDelivery() === 'console' ? { delivery: 'console' } : {}),
  });
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
  // Without a mail provider the verification code can't be delivered, and the
  // account would be stuck unverified. Say so instead of creating it.
  if (mailDelivery() === 'none') {
    throw new HttpError(503, "Email sign-up isn't available right now. Please continue with Google.");
  }

  const user = await createUser({
    email: body.email,
    name: body.name || null,
    passwordHash: await hashPassword(body.password),
  });
  if (!user) {
    throw new HttpError(409, 'An account with this email already exists. Log in instead.');
  }

  // The account exists but stays locked until the emailed code is entered.
  await sendCode(user);
  verificationRequired(res, user, 201);
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

  // Right password, but the email was never confirmed: send a code first.
  if (!user.email_verified) {
    await sendCode(user);
    return verificationRequired(res, user);
  }

  res.json(await startSession(req, res, user));
});

authRouter.post('/verify-email-code', async (req, res) => {
  await rateLimit({ key: `otp-verify:ip:${ipKey(req)}`, max: 30, windowSeconds: 15 * 60 });

  const body = parseBody(
    z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email.') }),
    req.body
  );
  const user = await findUserByEmail(body.email);
  if (!user) throw new HttpError(400, BAD_CODE);

  const failKey = `otp-fail:${user.id}`;
  await assertUnderLimit(failKey, MAX_OTP_ATTEMPTS, 'Too many incorrect codes. Request a new code.');

  if (!(await consumeVerificationCode(user.id, body.code))) {
    await recordHit(failKey, OTP_TTL_MINUTES * 60);
    try {
      await assertUnderLimit(failKey, MAX_OTP_ATTEMPTS, '');
    } catch {
      // Out of guesses: the current code is dead, a new one must be requested.
      await revokeVerificationCodes(user.id);
    }
    throw new HttpError(400, BAD_CODE);
  }

  await clearLimit(failKey);
  await query(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, [user.id]);
  const verified = await findUserById(user.id);
  if (!verified) throw new HttpError(400, BAD_CODE);
  res.json(await startSession(req, res, verified));
});

authRouter.post('/resend-verification-code', async (req, res) => {
  await rateLimit({ key: `otp-resend:ip:${ipKey(req)}`, max: 20, windowSeconds: HOUR });

  const body = parseBody(z.object({ email }), req.body);
  const user = await findUserByEmail(body.email);
  if (user && !user.email_verified) {
    await rateLimit({
      key: `otp-cooldown:${user.id}`,
      max: 1,
      windowSeconds: 30,
      message: 'Please wait a few seconds before requesting another code.',
    });
    await clearLimit(`otp-fail:${user.id}`);
    await sendCode(user);
  }

  // Same answer whether or not the account exists.
  res.json({ ok: true, message: 'If that account is waiting for verification, a new code is on its way.' });
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

authRouter.post('/forgot-password', async (req, res) => {
  await rateLimit({ key: `forgot:ip:${ipKey(req)}`, max: 10, windowSeconds: HOUR });

  const body = parseBody(z.object({ email }), req.body);
  await rateLimit({ key: `forgot:email:${normalizeEmail(body.email)}`, max: 3, windowSeconds: HOUR });

  const user = await findUserByEmail(body.email);
  if (user) {
    // A delivery failure is logged, not reported: the answer must stay the same
    // whether or not the account exists.
    await sendPasswordResetEmail(user).catch((err) => {
      if (!(err instanceof MailError)) throw err;
    });
  }

  // Same answer either way: this endpoint must not reveal who has an account.
  res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
});

authRouter.post('/reset-password', async (req, res) => {
  await rateLimit({ key: `reset:ip:${ipKey(req)}`, max: 20, windowSeconds: HOUR });

  const body = parseBody(z.object({ token, password }), req.body);
  const userId = await consumeResetToken(body.token);
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
