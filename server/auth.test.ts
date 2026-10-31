import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, UnsecuredJWT } from 'jose';

process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.APP_URL = 'http://localhost:5173';

const { createApp } = await import('./app.js');
const { query } = await import('./db/index.js');
const { verifyGoogleIdToken } = await import('./auth/google.js');

let base = '';
let close: () => void;

before(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

interface Call {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function api(method: string, path: string, { token, cookie, body, headers = {} }: Call = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie') || '';
  const rt = /ib_rt=([^;]*)/.exec(setCookie)?.[1];
  return { res, status: res.status, data: text ? JSON.parse(text) : {}, cookie: rt ? `ib_rt=${rt}` : undefined, setCookie };
}

const csrf = { 'X-Requested-With': 'IdeaBird' };
let n = 0;
const uniqueEmail = () => `user${++n}-${Date.now()}@example.com`;

/** Runs `action` and returns everything the dev mailer printed (emails go to the console in tests). */
async function captureMail<T>(action: () => Promise<T>): Promise<{ result: T; mail: string }> {
  const original = console.log;
  let mail = '';
  console.log = (...args: unknown[]) => {
    mail += args.join(' ') + '\n';
  };
  try {
    return { result: await action(), mail };
  } finally {
    console.log = original;
  }
}

const codeIn = (mail: string) => /\b(\d{6})\b/.exec(mail)?.[1] ?? '';

/** Signs up and completes the emailed-code step, returning a logged-in user. */
async function signup(email = uniqueEmail(), password = 'correct horse battery') {
  // Every test request comes from 127.0.0.1; don't let the per-IP signup limit
  // bleed between tests (it has its own test below).
  await query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`);
  const { result: r, mail } = await captureMail(() => api('POST', '/api/auth/signup', { body: { email, password } }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'verification_required');

  const v = await api('POST', '/api/auth/verify-email-code', { body: { email, code: codeIn(mail) } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return { email, password, token: v.data.accessToken as string, cookie: v.cookie!, id: v.data.user.id as string };
}

describe('signup and login', () => {
  test('signup issues no session until the emailed code is entered', async () => {
    await query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`);
    const email = uniqueEmail();
    const { result: r, mail } = await captureMail(() => api('POST', '/api/auth/signup', { body: { email, password: 'long enough pw' } }));
    assert.equal(r.status, 201);
    // No email provider in tests, so the dev server reports that the code went to the console.
    assert.deepEqual(r.data, { status: 'verification_required', email, delivery: 'console' });
    assert.equal(r.cookie, undefined);
    assert.match(mail, /verification code/i);

    const v = await api('POST', '/api/auth/verify-email-code', { body: { email, code: codeIn(mail) } });
    assert.equal(v.status, 200);
    assert.ok(v.data.accessToken);
    assert.equal(v.data.user.emailVerified, true);
    assert.equal(v.data.user.password_hash, undefined);
    assert.match(v.setCookie, /HttpOnly/i);
    assert.match(v.setCookie, /SameSite=Strict/i);
    assert.match(v.setCookie, /Path=\/api\/auth/i);
  });

  test('signup is rate limited per IP', async () => {
    await query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`);
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await api('POST', '/api/auth/signup', { body: { email: uniqueEmail(), password: 'long enough pw' } })).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
    await query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`);
  });

  test('passwords are stored as scrypt hashes, never plaintext', async () => {
    const u = await signup();
    const [row] = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(u.password));
  });

  test('rejects weak passwords, bad emails, and duplicates', async () => {
    assert.equal((await api('POST', '/api/auth/signup', { body: { email: uniqueEmail(), password: 'short' } })).status, 400);
    assert.equal((await api('POST', '/api/auth/signup', { body: { email: 'nope', password: 'long enough pw' } })).status, 400);
    const u = await signup();
    const dup = await api('POST', '/api/auth/signup', { body: { email: u.email.toUpperCase(), password: 'another long pw' } });
    assert.equal(dup.status, 409);
  });

  test('login succeeds with the right password and gives the same error for wrong password or unknown email', async () => {
    const u = await signup();
    assert.equal((await api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 200);
    const wrong = await api('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong password' } });
    const unknown = await api('POST', '/api/auth/login', { body: { email: uniqueEmail(), password: 'wrong password' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.data.error, unknown.data.error);
  });

  test('locks an email after 5 failures, for existing and unknown accounts alike', async () => {
    const u = await signup();
    const ghost = uniqueEmail();
    for (let i = 0; i < 5; i++) {
      await api('POST', '/api/auth/login', { body: { email: u.email, password: 'bad password' } });
      await api('POST', '/api/auth/login', { body: { email: ghost, password: 'bad password' } });
    }
    const locked = await api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
    const ghostLocked = await api('POST', '/api/auth/login', { body: { email: ghost, password: 'bad password' } });
    assert.equal(locked.status, 429);
    assert.equal(ghostLocked.status, 429);
    assert.equal(locked.data.error, ghostLocked.data.error);
    assert.ok(locked.res.headers.get('retry-after'));
  });
});

describe('token authorization', () => {
  test('protected routes require a valid bearer token', async () => {
    const u = await signup();
    assert.equal((await api('GET', '/api/auth/me')).status, 401);
    assert.equal((await api('POST', '/api/generate', { body: { text: 'hello' } })).status, 401);
    assert.equal((await api('GET', '/api/history')).status, 401);
    const me = await api('GET', '/api/auth/me', { token: u.token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.id, u.id);
  });

  test('rejects tampered, unsigned, and wrongly signed tokens', async () => {
    const u = await signup();
    const victim = await signup();
    const [header, payload, signature] = u.token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: victim.id })
    ).toString('base64url');

    const tampered = `${header}.${forgedPayload}.${signature}`;
    const unsigned = new UnsecuredJWT({ ver: 0 }).setSubject(victim.id).setIssuer('ideabird').setAudience('ideabird-api').setExpirationTime('5m').encode();
    const wrongKey = await new SignJWT({ ver: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(victim.id)
      .setIssuer('ideabird')
      .setAudience('ideabird-api')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('attacker-guessed-secret-attacker-guessed'));

    for (const token of [tampered, unsigned, wrongKey]) {
      assert.equal((await api('GET', '/api/auth/me', { token })).status, 401);
    }
  });

  test('logout-all invalidates existing access tokens and refresh cookies', async () => {
    const u = await signup();
    assert.equal((await api('POST', '/api/auth/logout-all', { token: u.token })).status, 204);
    assert.equal((await api('GET', '/api/auth/me', { token: u.token })).status, 401);
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf })).status, 401);
  });
});

describe('refresh tokens', () => {
  test('rotate on every refresh', async () => {
    const u = await signup();
    const first = await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf });
    assert.equal(first.status, 200);
    assert.ok(first.data.accessToken);
    assert.notEqual(first.cookie, u.cookie);
  });

  test('replaying a rotated token revokes the whole session family', async () => {
    const u = await signup();
    const rotated = await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf });
    // Age the old token's revocation past the concurrent-refresh grace window.
    await query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [u.id]);

    const replay = await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf });
    assert.equal(replay.status, 401);
    // The legitimate (newest) token was killed too.
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: rotated.cookie, headers: csrf })).status, 401);
  });

  test('refresh and logout are CSRF-protected', async () => {
    const u = await signup();
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: u.cookie })).status, 403);
    const crossSite = await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: { ...csrf, Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
    assert.equal((await api('POST', '/api/auth/logout', { cookie: u.cookie })).status, 403);
  });

  test('logout revokes the refresh token', async () => {
    const u = await signup();
    assert.equal((await api('POST', '/api/auth/logout', { cookie: u.cookie, headers: csrf })).status, 204);
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf })).status, 401);
  });
});

describe('password reset and email verification', () => {
  async function captureMailLink(action: () => Promise<unknown>, param: 'reset' | 'verify') {
    const original = console.log;
    let link = '';
    console.log = (...args: unknown[]) => {
      const match = new RegExp(`\\?${param}=([\\w-]+)`).exec(args.join(' '));
      if (match) link = match[1];
    };
    try {
      await action();
    } finally {
      console.log = original;
    }
    return link;
  }

  test('forgot-password answers identically for unknown emails', async () => {
    const u = await signup();
    const known = await api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
    const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: uniqueEmail() } });
    assert.equal(known.status, 200);
    assert.deepEqual(known.data, unknown.data);
  });

  test('reset link works once, changes the password, and revokes old sessions', async () => {
    const u = await signup();
    const token = await captureMailLink(() => api('POST', '/api/auth/forgot-password', { body: { email: u.email } }), 'reset');
    assert.ok(token);

    const reset = await api('POST', '/api/auth/reset-password', { body: { token, password: 'brand new password' } });
    assert.equal(reset.status, 200);
    assert.equal((await api('GET', '/api/auth/me', { token: u.token })).status, 401);
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: u.cookie, headers: csrf })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: u.email, password: 'brand new password' } })).status, 200);
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token, password: 'another password!' } })).status, 400);
  });

  test('email tokens are stored hashed', async () => {
    const u = await signup();
    const token = await captureMailLink(() => api('POST', '/api/auth/forgot-password', { body: { email: u.email } }), 'reset');
    const rows = await query<{ token_hash: string }>('SELECT token_hash FROM email_tokens WHERE user_id = $1', [u.id]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.token_hash !== token));
  });
});

describe('data isolation', () => {
  test("a user can't list, read, or delete another user's generations", async () => {
    const alice = await signup();
    const bob = await signup();
    // History is a Pro feature; isolation must hold where it's available.
    await query(`UPDATE users SET plan = 'pro' WHERE id = ANY($1)`, [[alice.id, bob.id]]);
    const [gen] = await query<{ id: string }>(
      `INSERT INTO generations (user_id, source_text, tweets) VALUES ($1, 'alice secret', '[]') RETURNING id`,
      [alice.id]
    );

    const bobList = await api('GET', '/api/history', { token: bob.token });
    assert.equal(bobList.status, 200);
    assert.equal(bobList.data.items.length, 0);

    assert.equal((await api('GET', `/api/history/${gen.id}`, { token: bob.token })).status, 404);
    assert.equal((await api('DELETE', `/api/history/${gen.id}`, { token: bob.token })).status, 404);

    const aliceGet = await api('GET', `/api/history/${gen.id}`, { token: alice.token });
    assert.equal(aliceGet.status, 200);
    assert.equal(aliceGet.data.item.sourceText, 'alice secret');

    assert.equal((await api('DELETE', `/api/history/${gen.id}`, { token: alice.token })).status, 204);
    assert.equal((await api('GET', `/api/history/${gen.id}`, { token: alice.token })).status, 404);
  });

  test('malformed ids and SQL-looking input are handled safely', async () => {
    const u = await signup();
    await query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [u.id]);
    assert.equal((await api('GET', `/api/history/${encodeURIComponent("1' OR '1'='1")}`, { token: u.token })).status, 404);
    const r = await api('POST', '/api/auth/login', { body: { email: "x'--@example.com", password: "' OR 1=1 --" } });
    assert.equal(r.status, 401);
  });
});

describe('google sign-in', () => {
  test('accepts only correctly signed tokens for our client id with a verified email', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
    const sign = (claims: Record<string, unknown>, audience = process.env.GOOGLE_CLIENT_ID!) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setSubject('google-123')
        .setExpirationTime('5m')
        .sign(privateKey);

    const profile = await verifyGoogleIdToken(await sign({ email: 'g@example.com', email_verified: true }), keys);
    assert.equal(profile.sub, 'google-123');

    await assert.rejects(verifyGoogleIdToken(await sign({ email: 'g@example.com', email_verified: false }), keys));
    await assert.rejects(verifyGoogleIdToken(await sign({ email: 'g@example.com', email_verified: true }, 'someone-else'), keys));
  });
});

describe('hardening', () => {
  test('API responses carry security headers and are not cacheable', async () => {
    const r = await api('GET', '/api/auth/config');
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.ok(r.res.headers.get('content-security-policy'));
    assert.equal(r.res.headers.get('x-powered-by'), null);
  });

  test('errors never leak internals', async () => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'Invalid JSON request body.' });
  });
});

describe('email verification code', () => {
  async function pendingSignup() {
    await query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`);
    const email = uniqueEmail();
    const { mail } = await captureMail(() => api('POST', '/api/auth/signup', { body: { email, password: 'long enough pw' } }));
    return { email, code: codeIn(mail) };
  }

  test('a wrong code is rejected and the account stays locked', async () => {
    const { email, code } = await pendingSignup();
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code: wrong } })).status, 400);
    const [row] = await query<{ email_verified: boolean }>('SELECT email_verified FROM users WHERE email = $1', [email]);
    assert.equal(row.email_verified, false);
  });

  test('a code works only once', async () => {
    const { email, code } = await pendingSignup();
    assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code } })).status, 200);
    assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code } })).status, 400);
  });

  test('five wrong guesses burn the code, even if the right one comes next', async () => {
    const { email, code } = await pendingSignup();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code: wrong } })).status, 400);
    }
    const blocked = await api('POST', '/api/auth/verify-email-code', { body: { email, code } });
    assert.equal(blocked.status, 429);
  });

  test('resend issues a new code and invalidates the old one, with a cooldown', async () => {
    const { email, code: first } = await pendingSignup();
    // The signup itself started the cooldown; skip it for this test.
    await query(`DELETE FROM rate_limits WHERE key LIKE 'otp-cooldown:%'`);
    const { result: resent, mail } = await captureMail(() => api('POST', '/api/auth/resend-verification-code', { body: { email } }));
    assert.equal(resent.status, 200);
    const second = codeIn(mail);
    assert.ok(second);

    const again = await api('POST', '/api/auth/resend-verification-code', { body: { email } });
    assert.equal(again.status, 429, 'second resend inside 30s is refused');

    if (first !== second) {
      assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code: first } })).status, 400);
    }
    assert.equal((await api('POST', '/api/auth/verify-email-code', { body: { email, code: second } })).status, 200);
  });

  test('resend answers identically for unknown emails', async () => {
    const unknown = await api('POST', '/api/auth/resend-verification-code', { body: { email: uniqueEmail() } });
    assert.equal(unknown.status, 200);
    assert.ok(unknown.data.ok);
  });

  test('logging in to an unverified account asks for a code instead of issuing a session', async () => {
    const { email } = await pendingSignup();
    await query(`DELETE FROM rate_limits WHERE key LIKE 'otp-%'`);
    const { result: login, mail } = await captureMail(() =>
      api('POST', '/api/auth/login', { body: { email, password: 'long enough pw' } })
    );
    assert.equal(login.status, 200);
    assert.equal(login.data.status, 'verification_required');
    assert.equal(login.data.accessToken, undefined);
    assert.equal(login.cookie, undefined);

    const v = await api('POST', '/api/auth/verify-email-code', { body: { email, code: codeIn(mail) } });
    assert.equal(v.status, 200);
    assert.ok(v.data.accessToken);
  });

  test('codes are stored as keyed hashes, never in plain text', async () => {
    const { email, code } = await pendingSignup();
    const rows = await query<{ token_hash: string }>(
      `SELECT t.token_hash FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1 AND t.purpose = 'verify'`,
      [email]
    );
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !r.token_hash.includes(code) && r.token_hash.length === 64));
  });
});

describe('Write Like Me while hidden', () => {
  test('is hidden and its endpoints do not exist unless WRITE_LIKE_ME=on', async () => {
    const u = await signup();
    const status = await api('GET', '/api/voice', { token: u.token });
    assert.equal(status.status, 200);
    assert.deepEqual(status.data, { hidden: true });
    for (const [method, path] of [['POST', '/api/voice/connect'], ['POST', '/api/voice/refresh'], ['PATCH', '/api/voice'], ['DELETE', '/api/voice'], ['GET', '/api/voice/x/callback']]) {
      assert.equal((await api(method, path, { token: u.token, body: method === 'PATCH' ? { enabled: true } : undefined })).status, 404, `${method} ${path}`);
    }
  });
});
