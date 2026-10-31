import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

// Fake NVIDIA endpoint: records each call and answers per test.
interface Call {
  model: string;
  hasImage: boolean;
  text: string;
}
let calls: Call[] = [];
let visionAnswer: Record<string, unknown>;
let refineAnswer: Record<string, unknown> | null;

const TWEETS = JSON.stringify([
  { style: 'Hot Take Tweet', tweet: 'Honestly, $12,430 in October with 1,240 users is the boring kind of traction I trust. 42% growth beats any launch day spike.' },
  { style: 'Question Tweet', tweet: 'We hit $12,430 revenue and 1,240 users in October. If you saw 42% growth, would you double down or slow down to fix things?' },
  { style: 'Stat-Lead Tweet', tweet: '42% growth in October: $12,430 revenue, 1,240 users. The weird part is nothing we shipped felt big at the time.' },
  { style: 'Thread', tweet: '1. October: $12,430 revenue and 1,240 users.\n2. That is 42% growth.\n3. I think the boring work did it.\n4. We fixed onboarding first.\n5. Here is what I would repeat.' },
  { style: 'LinkedIn Version', tweet: 'October closed at $12,430 in revenue and 1,240 users.\n\nThat is 42% growth, and none of it came from a big launch. Small fixes compound.' },
]);

const nim = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const parts = parsed.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]));
    const call: Call = {
      model: parsed.model,
      hasImage: parts.some((p: { type: string }) => p.type === 'image_url'),
      text: parts.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('\n'),
    };
    calls.push(call);

    let content: string;
    if (call.hasImage) content = 'Here you go:\n```json\n' + JSON.stringify(visionAnswer) + '\n```';
    else if (call.text.includes('OCR TEXT')) content = JSON.stringify(refineAnswer ?? {});
    else content = TWEETS;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
});
await new Promise<void>((resolve) => nim.listen(0, resolve));

process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${(nim.address() as AddressInfo).port}`;
process.env.NVIDIA_API_KEY = 'test-key';
process.env.NVIDIA_MODEL = 'writer/model';
process.env.NVIDIA_VISION_MODEL = 'vision/model';
process.env.NVIDIA_VISION_FALLBACK_MODELS = '';
process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.APP_URL = 'http://localhost:5173';

const { createApp } = await import('./app.js');
const { query } = await import('./db/index.js');

// Smallest valid PNG (1x1).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const CLEAR_DASHBOARD = {
  summary: 'An October dashboard: $12,430 revenue, 1,240 users, 42% growth.',
  keyFacts: ['Revenue reached $12,430 in October'],
  metrics: [
    { label: 'Revenue', value: '$12,430' },
    { label: 'Users', value: '1,240' },
    { label: 'Growth', value: '+42%' },
  ],
  notablePoints: ['Growth is strong for the user count'],
  possibleStories: ['Revenue milestone', 'Build-in-public update'],
  contentAngles: ['What caused the 42% growth', 'Lessons from the first $10k'],
  uncertainties: [],
  readability: 'clear',
  misinformationRisk: false,
};

let base = '';
let closeApp: () => void;

before(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeApp = () => server.close();
});
after(() => {
  closeApp();
  nim.close();
});
beforeEach(() => {
  calls = [];
  visionAnswer = CLEAR_DASHBOARD;
  refineAnswer = null;
});

// Test assertions read arbitrary JSON bodies.
type Json = any;

async function api(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: Json }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** Five drafts and saved history are Pro; most pipeline tests check those. */
async function makePro(token: string) {
  const { sub } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  await query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [sub]);
}

let n = 0;
/** Signs up and enters the emailed code (the dev mailer prints it to the console). */
async function signup() {
  await query(`DELETE FROM rate_limits`);
  const email = `v${++n}-${Date.now()}@example.com`;
  const original = console.log;
  let mail = '';
  console.log = (...args: unknown[]) => {
    mail += args.join(' ');
  };
  let r;
  try {
    r = await api('POST', '/api/auth/signup', undefined, { email, password: 'long enough pw' });
  } finally {
    console.log = original;
  }
  assert.equal(r.status, 201);
  const code = /\b(\d{6})\b/.exec(mail)?.[1];
  const v = await api('POST', '/api/auth/verify-email-code', undefined, { email, code });
  assert.equal(v.status, 200);
  return v.data.accessToken as string;
}

describe('vision-first pipeline', () => {
  test('analyze sends the image to the vision model once, with no OCR and no separate moderation call', async () => {
    const token = await signup();
    const r = await api('POST', '/api/analyze', token, { image: PNG });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.needsOcr, false);
    assert.equal(r.data.insight.summary, CLEAR_DASHBOARD.summary);
    assert.deepEqual(r.data.insight.metrics[2], { label: 'Growth', value: '+42%' });
    assert.deepEqual(r.data.insight.contentAngles, CLEAR_DASHBOARD.contentAngles);
    assert.equal(r.data.insight.readability, undefined, 'internal fields are not exposed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'vision/model');
    assert.equal(calls[0].hasImage, true);
  });

  test('the writer receives the structured insight (and chosen angle), not raw text', async () => {
    const token = await signup();
    await makePro(token);
    const analysis = await api('POST', '/api/analyze', token, { image: PNG });
    calls = [];
    const r = await api('POST', '/api/generate', token, {
      insight: analysis.data.insight,
      insightToken: analysis.data.insightToken,
      angle: 'What caused the 42% growth',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.tweets.length, 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasImage, false, 'the image is not sent to a second model');
    assert.match(calls[0].text, /SCREENSHOT UNDERSTANDING/);
    assert.match(calls[0].text, /Growth: \+42%/);
    assert.match(calls[0].text, /FOCUS ANGLE: .*What caused the 42% growth/);

    const history = await api('GET', '/api/history', token);
    assert.match(history.data.items[0].preview, /October dashboard/);
  });

  test('tampered insights and other users\' tokens are rejected', async () => {
    const alice = await signup();
    const bob = await signup();
    const analysis = await api('POST', '/api/analyze', alice, { image: PNG });
    const tampered = { ...analysis.data.insight, summary: 'Something the vision model never said' };

    assert.equal((await api('POST', '/api/generate', alice, { insight: tampered, insightToken: analysis.data.insightToken })).status, 403);
    assert.equal((await api('POST', '/api/generate', bob, { insight: analysis.data.insight, insightToken: analysis.data.insightToken })).status, 403);
    assert.equal((await api('POST', '/api/generate', alice, { insight: analysis.data.insight })).status, 400);
  });

  test('moderation happens in the vision call and blocks before any post is written', async () => {
    const token = await signup();
    visionAnswer = { ...CLEAR_DASHBOARD, misinformationRisk: true };
    const r = await api('POST', '/api/analyze', token, { image: PNG });
    assert.equal(r.data.status, 'policy_block');
    assert.equal(r.data.insightToken, undefined, 'no token, so generation is impossible');
    assert.equal(calls.length, 1);
  });

  test('OCR is requested only when vision reports unreadable information, then merged as evidence', async () => {
    const token = await signup();
    visionAnswer = { ...CLEAR_DASHBOARD, metrics: [{ label: 'Revenue', value: '$12,430' }], uncertainties: ['Tiny churn percentage in the footer'], readability: 'partial' };
    const analysis = await api('POST', '/api/analyze', token, { image: PNG });
    assert.equal(analysis.data.needsOcr, true);

    refineAnswer = { ...CLEAR_DASHBOARD, metrics: [{ label: 'Revenue', value: '$12,430' }, { label: 'Churn', value: '2.1%' }], uncertainties: [] };
    calls = [];
    const refined = await api('POST', '/api/analyze/refine', token, {
      insight: analysis.data.insight,
      insightToken: analysis.data.insightToken,
      ocrText: 'Revenue $12,430 ... churn 2.1%',
    });
    assert.equal(refined.status, 200);
    assert.deepEqual(refined.data.insight.metrics[1], { label: 'Churn', value: '2.1%' });
    assert.deepEqual(refined.data.insight.uncertainties, []);
    assert.equal(refined.data.insight.summary, CLEAR_DASHBOARD.summary, 'visual understanding is kept');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasImage, false, 'the image is not re-sent for the merge');

    const generated = await api('POST', '/api/generate', token, { insight: refined.data.insight, insightToken: refined.data.insightToken });
    assert.equal(generated.status, 200);
  });

  test('if the OCR merge fails, the visual analysis is kept', async () => {
    const token = await signup();
    visionAnswer = { ...CLEAR_DASHBOARD, uncertainties: ['Footer text'], readability: 'partial' };
    const analysis = await api('POST', '/api/analyze', token, { image: PNG });
    refineAnswer = {};
    const refined = await api('POST', '/api/analyze/refine', token, {
      insight: analysis.data.insight,
      insightToken: analysis.data.insightToken,
      ocrText: 'garbled',
    });
    assert.equal(refined.status, 200);
    assert.equal(refined.data.insight.summary, CLEAR_DASHBOARD.summary);
  });

  test('analyze requires login and a real image', async () => {
    assert.equal((await api('POST', '/api/analyze', undefined, { image: PNG })).status, 401);
    const token = await signup();
    assert.equal((await api('POST', '/api/analyze', token, { image: 'data:text/html;base64,PGgxPmhpPC9oMT4=' })).status, 400);
    // Declared PNG, but the bytes are not a PNG.
    assert.equal((await api('POST', '/api/analyze', token, { image: 'data:image/png;base64,PGgxPmhpPC9oMT4=' })).status, 400);
    assert.equal(calls.length, 0);
  });
});
