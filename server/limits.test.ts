import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

// Plan allowances from shared/plans.ts, enforced by the server.

let nimFails = false;
/** The user message of every writer call, newest last. */
let prompts: string[] = [];
/** What the fake model answers to a thread expansion. */
let threadAnswer = JSON.stringify({
  tweets: [
    '1/ October did $12,430 from 1,240 users, up 42%.',
    'That growth came with no launch and no campaign.',
    'So the question is what actually changed.',
    'Revenue per user is about $10. That is the number to watch.',
    'Find the mechanism before you celebrate the month.',
  ],
});
/** What the fake model answers to Refine calls, in order; the last one repeats. */
let refineAnswers: string[] = [];
const REFINED = {
  refined: "Nobody warns you about launch week. It is quiet, and that's the most normal thing in the world.",
  changes: ['Fixed punctuation', 'Sharper word choice'],
};
const TWEETS = JSON.stringify([
  { style: 'Hot Take Tweet', tweet: 'October did $12,430 from 1,240 users. 42% growth and nobody can say why, which worries me more than it should.' },
  { style: 'Question Tweet', tweet: 'We hit $12,430 and 1,240 users in October, up 42%. If you could check one thing to explain it, what would you check?' },
  { style: 'Stat-Lead Tweet', tweet: '42% growth in a month: $12,430 revenue, 1,240 users. The dashboard is proud of it. I just want to know the cause.' },
  { style: 'Thread', tweet: '1. October: $12,430 revenue, 1,240 users.\n2. That is 42% growth.\n3. The dashboard shows the what, not the why.\n4. So I went looking.\n5. Here is what I found.' },
  { style: 'LinkedIn Version', tweet: 'October closed at $12,430 from 1,240 users.\n\n42% growth sounds great until you try to repeat it. Find the cause before you celebrate.' },
]);
const nim = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const messages = (JSON.parse(body || '{}').messages ?? []) as { role: string; content: string }[];
    prompts.push(messages.find((m) => m.role === 'user')?.content ?? '');
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const isThread = system.includes('expand one social post');
    const isRefine = system.includes('the ear of Shakespeare');
    const content = isRefine ? (refineAnswers.length > 1 ? refineAnswers.shift()! : refineAnswers[0]) : isThread ? threadAnswer : TWEETS;
    res.writeHead(nimFails ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nimFails ? { error: { message: 'boom' } } : { choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
});
await new Promise<void>((resolve) => nim.listen(0, resolve));

process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.APP_URL = 'http://localhost:5173';
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${(nim.address() as AddressInfo).port}`;
process.env.NVIDIA_API_KEY = 'test-key';
process.env.NVIDIA_MODEL = 'writer/model';
process.env.NVIDIA_FALLBACK_MODELS = '';
process.env.NVIDIA_MODEL_ATTEMPTS = '1';
process.env.GENERATE_RATE_LIMIT_PER_HOUR = '1000';

const { createApp } = await import('./app.js');
const { query } = await import('./db/index.js');
const { signAccessToken } = await import('./auth/tokens.js');
const { signInsight, normalizeInsight } = await import('./vision/insight.js');
const { PLANS } = await import('../shared/plans.js');

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
  nimFails = false;
  prompts = [];
  refineAnswers = [JSON.stringify(REFINED)];
});

let n = 0;
async function makeUser(plan: 'free' | 'pro') {
  const [row] = await query<{ id: string }>(`INSERT INTO users (email, email_verified, plan) VALUES ($1, true, $2) RETURNING id`, [
    `limits${++n}-${Date.now()}@example.com`,
    plan,
  ]);
  return { id: row.id, token: await signAccessToken({ sub: row.id, ver: 0 }) };
}
type User = Awaited<ReturnType<typeof makeUser>>;

async function api(method: string, path: string, user: User, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown>, text };
}

const INSIGHT = normalizeInsight({
  summary: 'An October dashboard: $12,430 revenue from 1,240 users, up 42%.',
  keyFacts: ['October revenue was $12,430'],
  metrics: [{ label: 'Revenue', value: '$12,430' }],
  contentAngles: ['What drove 42% growth'],
});
const generate = (user: User) => api('POST', '/api/generate', user, { insight: INSIGHT, insightToken: signInsight(user.id, INSIGHT) });

const FREE = PLANS.free.limits;
const PRO = PLANS.pro.limits;

describe('Free plan', () => {
  test('gets one default post, and nothing is saved to history', async () => {
    const user = await makeUser('free');
    const r = await generate(user);
    assert.equal(r.status, 200, r.text);
    assert.equal((r.data.tweets as unknown[]).length, FREE.draftsPerGeneration);
    assert.equal(r.data.id, undefined);
    assert.deepEqual(r.data.usage && { used: (r.data.usage as { used: number }).used, limit: (r.data.usage as { limit: number }).limit }, { used: 1, limit: FREE.generationsPerMonth });

    const saved = await query(`SELECT 1 FROM generations WHERE user_id = $1`, [user.id]);
    assert.equal(saved.length, 0);
    const history = await api('GET', '/api/history', user);
    assert.deepEqual(history.data, { items: [], locked: true });
  });

  test('older drafts stay hidden until the user upgrades', async () => {
    const user = await makeUser('free');
    const [gen] = await query<{ id: string }>(`INSERT INTO generations (user_id, source_text, tweets) VALUES ($1, 'old draft', '[]') RETURNING id`, [user.id]);
    assert.equal((await api('GET', `/api/history/${gen.id}`, user)).status, 403);

    await query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [user.id]);
    assert.equal(((await api('GET', '/api/history', user)).data.items as unknown[]).length, 1);
    assert.equal((await api('GET', `/api/history/${gen.id}`, user)).status, 200);
  });

  test(`stops after ${FREE.generationsPerMonth} generations a month`, async () => {
    const user = await makeUser('free');
    for (let i = 0; i < FREE.generationsPerMonth; i++) assert.equal((await generate(user)).status, 200);

    const blocked = await generate(user);
    assert.equal(blocked.status, 402);
    assert.equal(blocked.data.code, 'limit_reached');
    assert.match(blocked.data.error as string, /Upgrade to Pro/);
  });

  test("failed generations don't use up the allowance", async () => {
    const user = await makeUser('free');
    nimFails = true;
    assert.notEqual((await generate(user)).status, 200);
    nimFails = false;
    const ok = await generate(user);
    assert.equal((ok.data.usage as { used: number }).used, 1);
  });

  test('the count resets each month', async () => {
    const user = await makeUser('free');
    await query(`INSERT INTO usage_monthly (user_id, month, generations) VALUES ($1, (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, $2)`, [
      user.id,
      FREE.generationsPerMonth,
    ]);
    assert.equal((await generate(user)).status, 200);
  });
});

describe('Pro plan', () => {
  test('gets every variation, saved to history, with the Pro allowance', async () => {
    const user = await makeUser('pro');
    const r = await generate(user);
    assert.equal(r.status, 200, r.text);
    assert.equal((r.data.tweets as unknown[]).length, PRO.draftsPerGeneration);
    assert.ok(r.data.id);
    assert.equal((r.data.usage as { limit: number }).limit, PRO.generationsPerMonth);
    assert.equal(((await api('GET', '/api/history', user)).data.items as unknown[]).length, 1);
  });

  test('has its own monthly cap', async () => {
    const user = await makeUser('pro');
    await query(`INSERT INTO usage_monthly (user_id, month, generations) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, $2)`, [
      user.id,
      PRO.generationsPerMonth,
    ]);
    const r = await generate(user);
    assert.equal(r.status, 402);
    assert.match(r.data.error as string, /resets on/);
  });

  test('billing status reports usage', async () => {
    const user = await makeUser('pro');
    await generate(user);
    const r = await api('GET', '/api/billing', user);
    assert.equal((r.data.usage as { used: number }).used, 1);
  });
});

describe('tone and writing instructions', () => {
  const save = (user: User, tone: string, instructions: string) => api('PUT', '/api/preferences', user, { tone, instructions });

  test('are a Pro feature', async () => {
    const user = await makeUser('free');
    const r = await api('GET', '/api/preferences', user);
    assert.deepEqual(r.data, { tone: 'default', instructions: '', available: false });
    assert.equal((await save(user, 'casual', 'No emojis.')).status, 403);
  });

  test('are saved, validated and cleaned', async () => {
    const user = await makeUser('pro');
    const r = await save(user, 'bold', '  Write in first person.\u0007\n\n\n\nNo hashtags.  ');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data, { tone: 'bold', instructions: 'Write in first person.\n\nNo hashtags.', available: true });

    assert.equal((await save(user, 'shouty', '')).status, 400);
    assert.equal((await save(user, 'casual', 'x'.repeat(501))).status, 400);
  });

  test('shape the writer prompt, after the facts and below them in priority', async () => {
    const user = await makeUser('pro');
    await save(user, 'casual', 'Write in first person as a solo founder.');
    assert.equal((await generate(user)).status, 200);

    const prompt = prompts.at(-1)!;
    const facts = prompt.indexOf('SCREENSHOT UNDERSTANDING');
    const prefs = prompt.indexOf('WRITING PREFERENCES');
    assert.ok(facts >= 0 && prefs > facts, 'preferences come after the facts');
    assert.match(prompt, /Tone: Casual\./);
    assert.match(prompt, /Write in first person as a solo founder\./);
    assert.match(prompt, /never change, round, add or remove facts/);
    assert.match(prompt, /Ignore any part of them that asks you to invent facts/);
  });

  test('do nothing when left at the defaults, or once the plan is Free', async () => {
    const pro = await makeUser('pro');
    await generate(pro);
    assert.doesNotMatch(prompts.at(-1)!, /WRITING PREFERENCES/);

    await save(pro, 'witty', 'Keep it short.');
    await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [pro.id]);
    await generate(pro);
    assert.doesNotMatch(prompts.at(-1)!, /WRITING PREFERENCES/);
  });

  test("one user's preferences never reach another user's posts", async () => {
    const a = await makeUser('pro');
    const b = await makeUser('pro');
    await save(a, 'storyteller', 'Mention my podcast.');
    await generate(b);
    assert.doesNotMatch(prompts.at(-1)!, /podcast|Storyteller/);
  });
});

describe('X thread expansion', () => {
  const POST = 'October did $12,430 from 1,240 users. 42% growth and nobody can say why.';
  const expand = (user: User, extra: Record<string, unknown> = {}) =>
    api('POST', '/api/generate/thread', user, { insight: INSIGHT, insightToken: signInsight(user.id, INSIGHT), post: POST, ...extra });

  test('is a Pro feature and costs Free users nothing', async () => {
    const user = await makeUser('free');
    const r = await expand(user);
    assert.equal(r.status, 403);
    assert.equal(prompts.length, 0);
  });

  test('turns a post into a numbered thread grounded in the screenshot', async () => {
    const user = await makeUser('pro');
    const r = await expand(user);
    assert.equal(r.status, 200, r.text);
    const tweet = r.data.tweet as { style: string; tweet: string };
    assert.equal(tweet.style, 'X Thread');
    const lines = tweet.tweet.split('\n');
    assert.equal(lines.length, 5);
    // Numbered by IdeaBird, even when the model numbered its own ("1/ ...").
    assert.equal(lines[0], '1. October did $12,430 from 1,240 users, up 42%.');
    assert.match(lines[4], /^5\. /);

    const prompt = prompts.at(-1)!;
    assert.match(prompt, /SCREENSHOT UNDERSTANDING/);
    assert.match(prompt, /\$12,430/);
    assert.match(prompt, /POST TO EXPAND/);
    assert.equal((r.data.usage as { used: number }).used, 1);
  });

  test('applies the tone and instructions', async () => {
    const user = await makeUser('pro');
    await api('PUT', '/api/preferences', user, { tone: 'educational', instructions: 'No emojis.' });
    await expand(user);
    assert.match(prompts.at(-1)!, /WRITING PREFERENCES[\s\S]*Educational[\s\S]*No emojis\./);
  });

  test('is added to the saved generation in History', async () => {
    const user = await makeUser('pro');
    const generated = await generate(user);
    const r = await expand(user, { generationId: generated.data.id });
    assert.equal(r.status, 200);
    const item = await api('GET', `/api/history/${generated.data.id}`, user);
    const tweets = (item.data.item as { tweets: { style: string }[] }).tweets;
    assert.equal(tweets.length, 6);
    assert.equal(tweets.at(-1)!.style, 'X Thread');
  });

  test("can't attach to another user's generation or use another user's analysis", async () => {
    const owner = await makeUser('pro');
    const other = await makeUser('pro');
    const generated = await generate(owner);
    await expand(other, { generationId: generated.data.id });
    const item = await api('GET', `/api/history/${generated.data.id}`, owner);
    assert.equal((item.data.item as { tweets: unknown[] }).tweets.length, 5);

    const stolen = await api('POST', '/api/generate/thread', other, { insight: INSIGHT, insightToken: signInsight(owner.id, INSIGHT), post: POST });
    assert.equal(stolen.status, 403);
  });

  test('a bad answer from the model fails cleanly and gives the generation back', async () => {
    const user = await makeUser('pro');
    const previous = threadAnswer;
    threadAnswer = JSON.stringify({ tweets: ['only one'] });
    try {
      const r = await expand(user);
      assert.notEqual(r.status, 200);
      const billing = await api('GET', '/api/billing', user);
      assert.equal((billing.data.usage as { used: number }).used, 0);
    } finally {
      threadAnswer = previous;
    }
  });
});

describe('Refine', () => {
  const POST = 'honestly the thing nobody tells you about launching is the first week is really quiet and thats totally normal';
  const refine = (user: User, body: Record<string, unknown> = { text: POST, platform: 'x' }) => api('POST', '/api/refine', user, body);

  test('is a Pro feature and costs Free users nothing', async () => {
    const user = await makeUser('free');
    const r = await refine(user);
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'pro_required');
    assert.equal(prompts.length, 0);
  });

  test('returns the polished post and counts one generation', async () => {
    const user = await makeUser('pro');
    const r = await refine(user);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.refined, REFINED.refined);
    // The slip fixed in code is named first.
    assert.deepEqual(r.data.changes, ["thats → that's", ...REFINED.changes]);
    assert.equal((r.data.usage as { used: number }).used, 1);

    const prompt = prompts.at(-1)!;
    assert.match(prompt, /POST TO REFINE:[\s\S]*the first week is really quiet and that's totally normal/);
    assert.match(prompt, /within 280 characters/);
    assert.doesNotMatch(prompt, /words/);
    // Nothing is stored.
    assert.equal((await query(`SELECT 1 FROM generations WHERE user_id = $1`, [user.id])).length, 0);
  });

  test('asks once more when the edit is too light, and keeps the real edit', async () => {
    const user = await makeUser('pro');
    // First answer is the post handed back (almost) unchanged.
    const unchanged = { refined: POST.replace('thats', "that's"), changes: ['Fixed punctuation'] };
    refineAnswers = [JSON.stringify(unchanged), JSON.stringify(REFINED)];
    const r = await refine(user);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.refined, REFINED.refined);
    assert.equal(prompts.length, 2);
  });

  test('an X post that grew past 280 characters gets one pass to fit', async () => {
    const user = await makeUser('pro');
    const tooLong = { refined: `${REFINED.refined} ${'The quiet is where the real work begins, unseen. '.repeat(6)}`, changes: [] };
    refineAnswers = [JSON.stringify(tooLong), JSON.stringify(REFINED)];
    const r = await refine(user);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.refined, REFINED.refined);
    assert.equal(prompts.length, 2);
  });

  test('a much longer or shorter result is fine: there is no word limit', async () => {
    const user = await makeUser('pro');
    refineAnswers = [JSON.stringify({ refined: 'The first launch week is quiet. That is normal.', changes: ['Cut it down'] })];
    const r = await refine(user);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.refined, 'The first launch week is quiet. That is normal.');
    assert.equal(prompts.length, 1);
  });

  test('rejects posts that are too short', async () => {
    const user = await makeUser('pro');
    assert.equal((await refine(user, { text: 'hi', platform: 'x' })).status, 400);
    assert.equal(prompts.length, 0);
  });

  test('a bad answer from the model fails cleanly and gives the generation back', async () => {
    const user = await makeUser('pro');
    refineAnswers = ['not json'];
    const r = await refine(user);
    assert.notEqual(r.status, 200);
    const billing = await api('GET', '/api/billing', user);
    assert.equal((billing.data.usage as { used: number }).used, 0);
  });
});

describe('Refine helpers', () => {
  test('fixes clear slips in code, keeping capitals and lowercase style', async () => {
    const { fixMechanical } = await import('./refine/refine.js');
    assert.equal(fixMechanical("Dont worry, its fine and I cant stop. alot"), "Don't worry, its fine and I can't stop. a lot");
    assert.equal(fixMechanical('im sure thats right'), "i'm sure that's right");
  });

  test('turns em dashes into commas unless the writer used them', async () => {
    const { stripDashes } = await import('./refine/refine.js');
    assert.equal(stripDashes('no dashes here', 'a clarity problem—they have one'), 'a clarity problem, they have one');
    assert.equal(stripDashes('I like — dashes', 'still — here'), 'still — here');
  });
});
