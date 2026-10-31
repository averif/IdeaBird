import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

// --- Fake X API ------------------------------------------------------------------
interface XRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  form: URLSearchParams;
}

const x = {
  requests: [] as XRequest[],
  timeline: [] as { id: string; text: string }[],
  meId: '42',
  username: 'maya',
  expectedChallenge: '',
  expiresIn: 7200,
  issued: new Set<string>(),
  refreshTokens: new Set<string>(),
  revoked: [] as string[],
  postsFailure: null as null | { status: number; headers?: Record<string, string> },
  refreshFails: false,
  counter: 0,
};

const fakeX = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://x');
    const call: XRequest = {
      method: req.method || 'GET',
      path: url.pathname,
      query: url.searchParams,
      auth: req.headers.authorization || '',
      form: new URLSearchParams(body),
    };
    x.requests.push(call);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const issue = () => {
      const access = `at-${++x.counter}`;
      const refresh = `rt-${x.counter}`;
      x.issued.add(access);
      x.refreshTokens.add(refresh);
      return send(200, { token_type: 'bearer', access_token: access, refresh_token: refresh, expires_in: x.expiresIn, scope: 'tweet.read users.read offline.access' });
    };

    if (call.path === '/2/oauth2/token') {
      const grant = call.form.get('grant_type');
      if (grant === 'authorization_code') {
        const verifier = call.form.get('code_verifier') || '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (call.form.get('code') !== 'good-code' || challenge !== x.expectedChallenge) return send(400, { error: 'invalid_request' });
        return issue();
      }
      if (grant === 'refresh_token') {
        const token = call.form.get('refresh_token') || '';
        if (x.refreshFails || !x.refreshTokens.delete(token)) return send(400, { error: 'invalid_request' });
        return issue();
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (call.path === '/2/oauth2/revoke') {
      const token = call.form.get('token') || '';
      x.revoked.push(token);
      x.issued.delete(token);
      x.refreshTokens.delete(token);
      return send(200, { revoked: true });
    }

    const bearer = call.auth.replace(/^Bearer /, '');
    if (!x.issued.has(bearer)) return send(401, { title: 'Unauthorized' });

    if (call.path === '/2/users/me') return send(200, { data: { id: x.meId, username: x.username, name: 'Maya' } });

    if (call.path === `/2/users/${x.meId}/tweets`) {
      if (x.postsFailure) return send(x.postsFailure.status, { title: 'error' }, x.postsFailure.headers);
      const offset = Number(call.query.get('pagination_token') || 0);
      // Pages of at most 50, so fetching 80 posts takes two pages.
      const size = Math.min(Number(call.query.get('max_results')), 50);
      const page = x.timeline.slice(offset, offset + size);
      const next = offset + size < x.timeline.length ? String(offset + size) : undefined;
      return send(200, { data: page.length ? page : undefined, meta: { result_count: page.length, ...(next ? { next_token: next } : {}) } });
    }
    return send(404, {});
  });
});

// --- Fake NVIDIA NIM ---------------------------------------------------------------
let nimFails = false;
let voiceAnswer: Record<string, unknown>;
let writerPrompts: string[] = [];
let voicePrompts: string[] = [];

const TWEETS = JSON.stringify([
  { style: 'Hot Take Tweet', tweet: 'october did $12,430 from 1,240 users. 42% growth and nobody can say why. that part worries me more than it should.' },
  { style: 'Question Tweet', tweet: 'we hit $12,430 and 1,240 users in october, up 42%. if you could only check one thing to explain it, what would you check?' },
  { style: 'Stat-Lead Tweet', tweet: '42% growth in a month. $12,430 revenue, 1,240 users. the dashboard is proud of it. i just want to know what caused it.' },
  { style: 'Thread', tweet: '1. october: $12,430 revenue, 1,240 users.\n2. that is 42% growth.\n3. the dashboard shows the what, not the why.\n4. so i went looking for the cause.\n5. here is what i found.' },
  { style: 'LinkedIn Version', tweet: 'October closed at $12,430 from 1,240 users.\n\n42% growth sounds great until you try to repeat it. Find the cause before you celebrate.' },
]);

const nim = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
    const system = parsed.messages.find((m) => m.role === 'system')?.content || '';
    const user = parsed.messages.find((m) => m.role === 'user')?.content || '';
    const isVoice = system.includes('how one person writes');
    if (isVoice) voicePrompts.push(user);
    else writerPrompts.push(user);

    if (nimFails) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: isVoice ? JSON.stringify(voiceAnswer) : TWEETS }, finish_reason: 'stop' }] }));
  });
});

for (const server of [fakeX, nim]) await new Promise<void>((resolve) => server.listen(0, resolve));
const portOf = (server: http.Server) => (server.address() as AddressInfo).port;

process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.APP_URL = 'http://localhost:5173';
process.env.WRITE_LIKE_ME = 'on';
process.env.X_CLIENT_ID = 'x-client';
process.env.X_CLIENT_SECRET = 'x-secret';
process.env.X_API_BASE_URL = `http://127.0.0.1:${portOf(fakeX)}`;
process.env.X_AUTHORIZE_URL = 'https://x.test/i/oauth2/authorize';
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${portOf(nim)}`;
process.env.NVIDIA_API_KEY = 'test-key';
process.env.NVIDIA_MODEL = 'writer/model';
process.env.NVIDIA_FALLBACK_MODELS = '';
process.env.NVIDIA_TIMEOUT_MS = '2000';
process.env.NVIDIA_MODEL_ATTEMPTS = '1';

const { createApp } = await import('./app.js');
const { query } = await import('./db/index.js');
const { signAccessToken } = await import('./auth/tokens.js');
const { signInsight, normalizeInsight } = await import('./vision/insight.js');
const { computeStats, copiesPosts, normalizeProfile } = await import('./voice/profile.js');
const { decrypt } = await import('./voice/connection.js');
const { X_SCOPES } = await import('./voice/xClient.js');

let base = '';
let closeApp: () => void;
before(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${portOf(server)}`;
  closeApp = () => server.close();
});
after(() => {
  closeApp();
  fakeX.close();
  nim.close();
});

/** A distinctive timeline: each post has its own wording, so copying is detectable. */
function makeTimeline(count: number) {
  const topics = ['onboarding', 'pricing', 'churn', 'hiring', 'docs', 'support', 'launches', 'retention'];
  return Array.from({ length: count }, (_, i) => ({
    id: String(1000 + i),
    text: `honestly the quiet part about ${topics[i % topics.length]} is nobody claps for it number ${i}. you just keep going`,
  }));
}

const GOOD_VOICE = {
  summary: 'You write short, lowercase, matter-of-fact posts that open with a blunt claim.',
  tone: ['dry and understated'],
  sentenceStyle: ['short declarative sentences'],
  vocabulary: ['plain everyday words'],
  hooks: ['opens with a blunt one-line claim', 'the quiet part about onboarding is nobody claps'],
  structure: ['single short paragraph'],
  punctuation: ['periods, almost no commas'],
  emoji: [],
  humor: ['dry understatement'],
  avoid: ['hashtags', 'exclamation marks'],
};

beforeEach(async () => {
  Object.assign(x, {
    requests: [],
    timeline: makeTimeline(120),
    meId: '42',
    username: 'maya',
    expiresIn: 7200,
    postsFailure: null,
    refreshFails: false,
    revoked: [],
  });
  nimFails = false;
  voiceAnswer = GOOD_VOICE;
  writerPrompts = [];
  voicePrompts = [];
  await query(`DELETE FROM rate_limits`);
});

let n = 0;
async function makeUser() {
  const [row] = await query<{ id: string }>(`INSERT INTO users (email, email_verified) VALUES ($1, true) RETURNING id`, [`voice${++n}-${Date.now()}@example.com`]);
  return { id: row.id, token: await signAccessToken({ sub: row.id, ver: 0 }) };
}
type User = Awaited<ReturnType<typeof makeUser>>;

async function api(method: string, path: string, { user, body, cookie }: { user?: User; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // redirects have no JSON body
  }
  return { res, status: res.status, data, text, location: res.headers.get('location') || '', setCookie: res.headers.get('set-cookie') || '' };
}

/** Starts the OAuth flow: returns the state and this browser's nonce cookie. */
async function startConnect(user: User) {
  const r = await api('POST', '/api/voice/connect', { user });
  assert.equal(r.status, 200, r.text);
  const url = new URL(r.data.url as string);
  x.expectedChallenge = url.searchParams.get('code_challenge') || '';
  const nonce = /ib_xs=([^;]+)/.exec(r.setCookie)?.[1] || '';
  return { url, state: url.searchParams.get('state') || '', cookie: `ib_xs=${nonce}`, setCookie: r.setCookie };
}

function callback(params: Record<string, string>, cookie?: string) {
  return api('GET', `/api/voice/x/callback?${new URLSearchParams(params)}`, { cookie });
}

async function connect(user: User) {
  const { state, cookie } = await startConnect(user);
  const r = await callback({ state, code: 'good-code' }, cookie);
  assert.equal(r.location, 'http://localhost:5173/?voice=connected');
}

async function connectAndLearn(user: User) {
  await connect(user);
  const r = await api('POST', '/api/voice/refresh', { user });
  assert.equal(r.status, 200, r.text);
  return r;
}

const INSIGHT = normalizeInsight({
  summary: 'An October dashboard: $12,430 revenue from 1,240 users, up 42%.',
  keyFacts: ['October revenue was $12,430', '1,240 users'],
  metrics: [
    { label: 'Revenue', value: '$12,430' },
    { label: 'Growth', value: '+42%' },
  ],
  contentAngles: ['What drove 42% growth', '$10 revenue per user'],
});

function generate(user: User, angle: string | null = null) {
  return api('POST', '/api/generate', { user, body: { insight: INSIGHT, insightToken: signInsight(user.id, INSIGHT), angle } });
}

describe('X OAuth connect', () => {
  test('requires login, asks for read-only scopes with PKCE, and binds the browser', async () => {
    assert.equal((await api('POST', '/api/voice/connect')).status, 401);

    const user = await makeUser();
    const { url, setCookie } = await startConnect(user);
    assert.equal(url.origin + url.pathname, 'https://x.test/i/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'x-client');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/api/voice/x/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((url.searchParams.get('state') || '').length >= 32);
    assert.deepEqual(url.searchParams.get('scope')?.split(' '), X_SCOPES);
    for (const scope of X_SCOPES) assert.doesNotMatch(scope, /write|like|follow|delete|dm/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\/api\/voice\/x\/callback/i);
    // Nothing secret leaks into the consent URL.
    assert.doesNotMatch(url.toString(), /x-secret/);
  });

  test('a successful callback stores encrypted tokens and never returns them', async () => {
    const user = await makeUser();
    await connect(user);

    const exchange = x.requests.find((r) => r.form.get('grant_type') === 'authorization_code')!;
    assert.equal(exchange.auth, `Basic ${Buffer.from('x-client:x-secret').toString('base64')}`);
    assert.equal(exchange.form.get('redirect_uri'), 'http://localhost:5173/api/voice/x/callback');

    const [row] = await query<{ access_token_enc: string; refresh_token_enc: string }>(
      `SELECT access_token_enc, refresh_token_enc FROM x_connections WHERE user_id = $1`,
      [user.id]
    );
    assert.doesNotMatch(row.access_token_enc, /at-\d/);
    assert.match(decrypt(row.access_token_enc) || '', /^at-\d+$/);

    const status = await api('GET', '/api/voice', { user });
    assert.deepEqual(status.data.connection, { username: 'maya', status: 'active' });
    assert.equal(status.data.profile, null);
    assert.doesNotMatch(status.text, /at-\d|rt-\d/);
  });

  test('invalid, reused, expired or cross-browser state is rejected', async () => {
    const user = await makeUser();

    assert.equal((await callback({ state: 'made-up', code: 'good-code' })).location, 'http://localhost:5173/?voice=invalid');

    const first = await startConnect(user);
    // Right state, but not the browser that started it.
    assert.equal((await callback({ state: first.state, code: 'good-code' }, 'ib_xs=someone-else')).location, 'http://localhost:5173/?voice=invalid');
    // Single use: that attempt consumed it.
    assert.equal((await callback({ state: first.state, code: 'good-code' }, first.cookie)).location, 'http://localhost:5173/?voice=invalid');

    const second = await startConnect(user);
    await query(`UPDATE x_oauth_states SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    assert.equal((await callback({ state: second.state, code: 'good-code' }, second.cookie)).location, 'http://localhost:5173/?voice=invalid');

    assert.equal((await api('GET', '/api/voice', { user })).data.connection, null);
  });

  test('refusing on X leaves IdeaBird unconnected', async () => {
    const user = await makeUser();
    const { state, cookie } = await startConnect(user);
    const r = await callback({ state, error: 'access_denied' }, cookie);
    assert.equal(r.location, 'http://localhost:5173/?voice=denied');
    assert.equal((await api('GET', '/api/voice', { user })).data.connection, null);
  });

  test('a failed token exchange reports failure', async () => {
    const user = await makeUser();
    const { state, cookie } = await startConnect(user);
    assert.equal((await callback({ state, code: 'bad-code' }, cookie)).location, 'http://localhost:5173/?voice=failed');
  });
});

describe('learning the voice', () => {
  test('fetches about 80 original posts across pages and stores only a style profile', async () => {
    const user = await makeUser();
    x.timeline.splice(3, 0, { id: '999', text: 'RT @someone: not mine' });
    const r = await connectAndLearn(user);

    const pages = x.requests.filter((req) => req.path === '/2/users/42/tweets');
    assert.equal(pages.length, 2);
    assert.equal(pages[0].query.get('exclude'), 'retweets,replies');
    assert.equal(pages[1].query.get('pagination_token'), '50');

    const profile = r.data.profile as { summary: string; postCount: number; enabled: boolean; traits: Record<string, string[]>; measured: string[] };
    assert.equal(profile.postCount, 80);
    assert.equal(profile.enabled, true);
    assert.match(profile.summary, /lowercase/);
    assert.ok(profile.measured.some((m) => /hashtags/.test(m)));

    // The posts went to the analysis model once and were never stored.
    assert.equal(voicePrompts.length, 1);
    assert.doesNotMatch(voicePrompts[0], /not mine/);
    const [row] = await query<{ profile: unknown }>(`SELECT profile FROM voice_profiles WHERE user_id = $1`, [user.id]);
    assert.doesNotMatch(JSON.stringify(row.profile), /nobody claps/);
  });

  test('profile traits that copy a post are dropped', async () => {
    const user = await makeUser();
    const r = await connectAndLearn(user);
    const hooks = (r.data.profile as { traits: { hooks: string[] } }).traits.hooks;
    assert.deepEqual(hooks, ['opens with a blunt one-line claim']);
  });

  test('empty and low-post accounts get a clear message', async () => {
    for (const count of [0, 6]) {
      const user = await makeUser();
      x.timeline = makeTimeline(count);
      await connect(user);
      const r = await api('POST', '/api/voice/refresh', { user });
      assert.equal(r.status, 422);
      assert.equal(r.data.error, "We couldn't find enough posts to learn your writing style yet.");
      assert.equal(voicePrompts.length, 0);
    }
  });

  test('X rate limits and outages fail gracefully and keep the connection', async () => {
    const user = await makeUser();
    await connect(user);

    x.postsFailure = { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) } };
    const limited = await api('POST', '/api/voice/refresh', { user });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'x_rate_limited');
    assert.match(limited.data.error as string, /10 minutes/);

    x.postsFailure = { status: 402 };
    const noCredits = await api('POST', '/api/voice/refresh', { user });
    assert.equal(noCredits.status, 503);
    assert.equal(noCredits.data.code, 'x_no_credits');
    assert.match(noCredits.data.error as string, /not your account/);

    x.postsFailure = { status: 503 };
    const down = await api('POST', '/api/voice/refresh', { user });
    assert.equal(down.status, 502);
    assert.equal(down.data.code, 'x_unavailable');

    assert.equal(((await api('GET', '/api/voice', { user })).data.connection as { status: string }).status, 'active');
  });

  test('an expired access token is refreshed automatically', async () => {
    const user = await makeUser();
    x.expiresIn = 30; // under the 60s safety margin, so it counts as expired
    await connect(user);
    x.expiresIn = 7200;
    await api('POST', '/api/voice/refresh', { user });
    assert.ok(x.requests.some((r) => r.form.get('grant_type') === 'refresh_token'));
    assert.equal((await api('GET', '/api/voice', { user })).data.profile !== null, true);
  });

  test('revoked or expired authorization asks the user to reconnect', async () => {
    // Refresh token rejected.
    const a = await makeUser();
    x.expiresIn = 30;
    await connect(a);
    x.refreshFails = true;
    const r1 = await api('POST', '/api/voice/refresh', { user: a });
    assert.equal(r1.status, 409);
    assert.equal(r1.data.error, 'Your X connection needs to be refreshed.');
    assert.equal(((await api('GET', '/api/voice', { user: a })).data.connection as { status: string }).status, 'expired');

    // Access revoked in X's settings: the posts call answers 401.
    x.expiresIn = 7200;
    x.refreshFails = false;
    const b = await makeUser();
    await connect(b);
    x.issued.clear();
    const r2 = await api('POST', '/api/voice/refresh', { user: b });
    assert.equal(r2.status, 409);
    assert.equal(r2.data.code, 'reconnect');
  });

  test('an AI failure keeps the previous profile', async () => {
    const user = await makeUser();
    await connectAndLearn(user);
    nimFails = true;
    const r = await api('POST', '/api/voice/refresh', { user });
    assert.equal(r.status, 502);
    assert.equal(r.data.code, 'analysis_failed');
    assert.notEqual((await api('GET', '/api/voice', { user })).data.profile, null);
  });

  test('connecting a different X account discards the old profile', async () => {
    const user = await makeUser();
    await connectAndLearn(user);
    x.meId = '77';
    x.username = 'other';
    await connect(user);
    const status = await api('GET', '/api/voice', { user });
    assert.equal((status.data.connection as { username: string }).username, 'other');
    assert.equal(status.data.profile, null);
  });
});

describe('generation with Write Like Me', () => {
  test('without a profile, generation works as before', async () => {
    const user = await makeUser();
    await query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [user.id]);
    const r = await generate(user);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.voice, false);
    assert.equal((r.data.tweets as unknown[]).length, 5);
    assert.doesNotMatch(writerPrompts[0], /VOICE PROFILE/);
  });

  test('with the voice on, the prompt keeps facts, angle and voice separate, in that order', async () => {
    const user = await makeUser();
    await connectAndLearn(user);
    const r = await generate(user, 'What drove 42% growth');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.voice, true);

    const prompt = writerPrompts.at(-1)!;
    const facts = prompt.indexOf('SCREENSHOT UNDERSTANDING');
    const angle = prompt.indexOf('CONTENT ANGLE');
    const voice = prompt.indexOf('VOICE PROFILE');
    assert.ok(facts >= 0 && facts < angle && angle < voice, 'facts, then angle, then voice');
    assert.match(prompt, /\$12,430/);
    assert.match(prompt, /Priority: facts > angle > voice/);
    assert.match(prompt, /lowercase/);
    assert.match(prompt, /Hooks: opens with a blunt one-line claim/);
    assert.match(prompt, /Never: hashtags; exclamation marks/);
    // Style only: the raw posts never reach the writer.
    assert.doesNotMatch(prompt, /nobody claps/);
    // The returned posts keep the screenshot's exact figures.
    assert.ok((r.data.tweets as { tweet: string }[]).some((t) => t.tweet.includes('$12,430')));
  });

  test('the toggle turns the voice off and on again', async () => {
    const user = await makeUser();
    await connectAndLearn(user);

    const off = await api('PATCH', '/api/voice', { user, body: { enabled: false } });
    assert.equal((off.data.profile as { enabled: boolean }).enabled, false);
    assert.equal((await generate(user)).data.voice, false);
    assert.doesNotMatch(writerPrompts.at(-1)!, /VOICE PROFILE/);

    await api('PATCH', '/api/voice', { user, body: { enabled: true } });
    assert.equal((await generate(user)).data.voice, true);
    assert.match(writerPrompts.at(-1)!, /VOICE PROFILE/);
  });

  test('an unreadable profile falls back to the default voice', async () => {
    const user = await makeUser();
    await query(`INSERT INTO voice_profiles (user_id, profile, post_count) VALUES ($1, '{}', 20)`, [user.id]);
    const r = await generate(user);
    assert.equal(r.status, 200);
    assert.equal(r.data.voice, false);
  });

  test("one user's voice never applies to another user", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await connectAndLearn(a);

    const status = await api('GET', '/api/voice', { user: b });
    assert.equal(status.data.connection, null);
    assert.equal(status.data.profile, null);
    assert.equal((await generate(b)).data.voice, false);
    assert.equal((await api('PATCH', '/api/voice', { user: b, body: { enabled: false } })).status, 404);
  });
});

describe('disconnect', () => {
  test('revokes the tokens at X and deletes the connection and profile', async () => {
    const user = await makeUser();
    await connectAndLearn(user);
    const r = await api('DELETE', '/api/voice', { user });
    assert.equal(r.status, 200);
    assert.equal(r.data.connection, null);
    assert.equal(r.data.profile, null);
    assert.ok(x.revoked.some((t) => t.startsWith('rt-')));
    assert.ok(x.revoked.some((t) => t.startsWith('at-')));
    const rows = await query(`SELECT 1 FROM x_connections WHERE user_id = $1 UNION ALL SELECT 1 FROM voice_profiles WHERE user_id = $1`, [user.id]);
    assert.equal(rows.length, 0);
    assert.equal((await generate(user)).data.voice, false);
  });
});

describe('voice profile helpers', () => {
  test('stats are measured from the posts', () => {
    const stats = computeStats([
      { id: '1', text: 'shipped it. no fanfare' },
      { id: '2', text: 'Big week!\n- one\n- two 🚀' },
    ]);
    assert.equal(stats.postCount, 2);
    assert.equal(stats.lowercaseStart, 0.5);
    assert.equal(stats.emoji, 0.5);
    assert.equal(stats.lists, 0.5);
    assert.equal(stats.hashtags, 0);
  });

  test('copy detection catches reused phrases but not general style words', () => {
    const posts = [{ id: '1', text: 'The best onboarding is the one nobody notices.' }];
    const grams = new Set<string>();
    const words = posts[0].text.toLowerCase().match(/[\p{L}\p{N}']+/gu)!;
    for (let i = 0; i + 4 <= words.length; i++) grams.add(words.slice(i, i + 4).join(' '));
    assert.equal(copiesPosts('says the one nobody notices often', grams), true);
    assert.equal(copiesPosts('short, dry sentences about product work', grams), false);

    const profile = normalizeProfile({ summary: 'You write plainly.', tone: ['the best onboarding is the one'], avoid: ['hashtags'] }, computeStats(posts), posts);
    assert.deepEqual(profile.traits.tone, []);
    assert.deepEqual(profile.avoid, ['hashtags']);
  });
});
