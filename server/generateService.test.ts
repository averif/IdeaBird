import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, describe, test } from 'node:test';

// A fake NVIDIA endpoint whose behavior each test controls.
interface Call {
  model: string;
  moderation: boolean;
  reasoningEffort?: string;
  aborted: boolean;
}
type Behavior = (call: Call) => { delayMs: number; status?: number; content?: string; error?: string };

let behavior: Behavior;
let calls: Call[] = [];

const TWEETS = JSON.stringify([
  { style: 'Hot Take Tweet', tweet: "Honestly, building before you talk to 20 customers is just expensive guessing. I think most startups fail right there." },
  { style: 'Question Tweet', tweet: 'If you had to talk to 20 customers before writing any code, who would you call first, and what would you ask them?' },
  { style: 'Stat-Lead Tweet', tweet: '20 customer conversations cost less than one wasted sprint. The weird part is most founders still skip them.' },
  { style: 'Thread', tweet: '1. Most startups fail building features nobody asked for.\n2. I think the fix is boring.\n3. Talk to 20 customers first.\n4. Write down the exact words they use.\n5. Then build the smallest thing.' },
  { style: 'LinkedIn Version', tweet: 'Most startups fail because they build features nobody asked for.\n\nI keep seeing it. Talk to 20 customers before writing any code.' },
]);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const call: Call = {
      model: parsed.model,
      moderation: JSON.stringify(parsed.messages).includes('Answer with exactly one word'),
      reasoningEffort: parsed.reasoning_effort,
      aborted: false,
    };
    calls.push(call);
    res.on('close', () => {
      if (!res.writableEnded) call.aborted = true;
    });

    const { delayMs, status = 200, content, error } = behavior(call);
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          status === 200
            ? { choices: [{ message: { content: content ?? (call.moderation ? 'no' : TWEETS) }, finish_reason: 'stop' }] }
            : { error: { message: error || 'error' } }
        )
      );
    }, delayMs);
  });
});

await new Promise<void>((resolve) => server.listen(0, resolve));
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.NVIDIA_API_KEY = 'test-key';
process.env.NVIDIA_MODEL = 'openai/gpt-oss-20b';
process.env.NVIDIA_FALLBACK_MODELS = 'backup/model';
process.env.NVIDIA_TIMEOUT_MS = '600';
process.env.NVIDIA_MODEL_ATTEMPTS = '2';
process.env.NVIDIA_MODERATION_GRACE_MS = '200';
process.env.NVIDIA_REASONING_EFFORT = 'low';

const { generateTweetsWithFallback } = await import('./generateService.js');
const SOURCE = 'Most startups fail because they build features nobody asked for. Talk to 20 customers before writing any code.';

beforeEach(() => {
  calls = [];
});
after(() => server.close());

async function timed<T>(fn: () => Promise<T>) {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

describe('generation speed', () => {
  test('moderation and generation run in parallel, not back to back', async () => {
    behavior = () => ({ delayMs: 300 });
    const { result, ms } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'ok');
    assert.ok(ms < 550, `took ${ms}ms; sequential calls would take ~600ms`);
    assert.equal(calls.length, 2);
  });

  test('a block verdict returns immediately and cancels the running generation', async () => {
    behavior = (call) => (call.moderation ? { delayMs: 50, content: 'yes' } : { delayMs: 500 });
    const { result, ms } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'policy_block');
    assert.ok(ms < 300, `took ${ms}ms`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.find((c) => !c.moderation)?.aborted, true);
  });

  test('a block verdict still wins when it arrives shortly after the posts', async () => {
    behavior = (call) => (call.moderation ? { delayMs: 150, content: 'yes' } : { delayMs: 50 });
    const { result } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'policy_block');
  });

  test("slow moderation doesn't hold back finished posts beyond the grace period", async () => {
    behavior = (call) => (call.moderation ? { delayMs: 2000 } : { delayMs: 50 });
    const { result, ms } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'ok');
    assert.ok(ms < 500, `took ${ms}ms`);
  });

  test('reasoning_effort=low is sent to gpt-oss and not to other models', async () => {
    behavior = (call) => (call.model === 'openai/gpt-oss-20b' && !call.moderation ? { delayMs: 10, status: 500 } : { delayMs: 10 });
    const { result } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'ok');
    assert.ok(calls.filter((c) => c.model === 'openai/gpt-oss-20b').every((c) => c.reasoningEffort === 'low'));
    assert.ok(calls.filter((c) => c.model === 'backup/model').every((c) => c.reasoningEffort === undefined));
  });

  test('a timed-out model is not retried; the next model is tried instead', async () => {
    behavior = (call) => (call.model === 'openai/gpt-oss-20b' && !call.moderation ? { delayMs: 5000 } : { delayMs: 50 });
    const { result, ms } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' && result.model, 'backup/model');
    assert.equal(calls.filter((c) => c.model === 'openai/gpt-oss-20b' && !c.moderation).length, 1);
    assert.ok(ms < 1000, `took ${ms}ms`);
  });

  test('if an endpoint rejects reasoning_effort, the call is retried without it', async () => {
    behavior = (call) =>
      call.reasoningEffort ? { delayMs: 10, status: 400, error: 'Unsupported parameter: reasoning_effort' } : { delayMs: 10 };
    const { result } = await timed(() => generateTweetsWithFallback(SOURCE));
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' && result.model, 'openai/gpt-oss-20b');
  });
});

describe('error reporting', () => {
  test('a slow primary model is reported instead of an unavailable fallback', async () => {
    behavior = (call) =>
      call.model === 'backup/model'
        ? { delayMs: 10, status: 404, error: "Function 'x': Not found for account 'secret-account'" }
        : call.moderation
          ? { delayMs: 10 }
          : { delayMs: 5000 };
    await assert.rejects(generateTweetsWithFallback(SOURCE), (err: Error & { timedOut?: boolean }) => {
      assert.equal(err.timedOut, true);
      assert.ok(!err.message.includes('secret-account'));
      return true;
    });
  });
});
