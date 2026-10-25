import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, describe, test } from 'node:test';

// A fake NVIDIA endpoint whose behavior each test controls.
interface Call {
  model: string;
  reasoningEffort?: string;
  thinkingOff: boolean;
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
      reasoningEffort: parsed.reasoning_effort,
      thinkingOff: parsed.chat_template_kwargs?.enable_thinking === false,
    };
    calls.push(call);

    const { delayMs, status = 200, content, error } = behavior(call);
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          status === 200
            ? { choices: [{ message: { content: content ?? TWEETS }, finish_reason: 'stop' }] }
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
process.env.NVIDIA_FALLBACK_MODELS = 'backup/model,nvidia/nemotron-writer';
process.env.NVIDIA_TIMEOUT_MS = '600';
process.env.NVIDIA_MODEL_ATTEMPTS = '2';
process.env.NVIDIA_REASONING_EFFORT = 'low';

const { generateTweetsWithFallback } = await import('./generateService.js');
const SOURCE = {
  insightBrief: 'Summary: Most startups fail because they build features nobody asked for.',
  sourceText: 'Most startups fail because they build features nobody asked for. Talk to 20 customers before writing any code.',
};

beforeEach(() => {
  calls = [];
});
after(() => server.close());

describe('model calls', () => {
  test('reasoning_effort=low is sent to gpt-oss and not to other models', async () => {
    behavior = (call) => (call.model === 'openai/gpt-oss-20b' ? { delayMs: 10, status: 500 } : { delayMs: 10 });
    const result = await generateTweetsWithFallback(SOURCE);
    assert.equal(result.model, 'backup/model');
    assert.ok(calls.filter((c) => c.model === 'openai/gpt-oss-20b').every((c) => c.reasoningEffort === 'low'));
    assert.ok(calls.filter((c) => c.model === 'backup/model').every((c) => c.reasoningEffort === undefined));
  });

  test('a timed-out model is not retried; the next model is tried instead', async () => {
    behavior = (call) => (call.model === 'openai/gpt-oss-20b' ? { delayMs: 5000 } : { delayMs: 50 });
    const start = Date.now();
    const result = await generateTweetsWithFallback(SOURCE);
    assert.equal(result.model, 'backup/model');
    assert.equal(calls.filter((c) => c.model === 'openai/gpt-oss-20b').length, 1);
    assert.ok(Date.now() - start < 1000);
  });

  test('if an endpoint rejects reasoning_effort, the call is retried without it', async () => {
    behavior = (call) =>
      call.reasoningEffort ? { delayMs: 10, status: 400, error: 'Unsupported parameter: reasoning_effort' } : { delayMs: 10 };
    const result = await generateTweetsWithFallback(SOURCE);
    assert.equal(result.model, 'openai/gpt-oss-20b');
  });
});

describe('error reporting', () => {
  test('a slow primary model is reported instead of an unavailable fallback', async () => {
    behavior = (call) =>
      call.model === 'backup/model'
        ? { delayMs: 10, status: 404, error: "Function 'x': Not found for account 'secret-account'" }
        : { delayMs: 5000 };
    await assert.rejects(generateTweetsWithFallback(SOURCE), (err: Error & { timedOut?: boolean }) => {
      assert.equal(err.timedOut, true);
      assert.ok(!err.message.includes('secret-account'));
      return true;
    });
  });
});

describe('thinking toggle', () => {
  test('nemotron writers are asked to skip hidden reasoning; other models are not', async () => {
    behavior = (call) => (call.model.includes('nemotron') ? { delayMs: 10 } : { delayMs: 10, status: 500 });
    const result = await generateTweetsWithFallback(SOURCE);
    assert.equal(result.model, 'nvidia/nemotron-writer');
    assert.ok(calls.filter((c) => c.model.includes('nemotron')).every((c) => c.thinkingOff));
    assert.ok(calls.filter((c) => !c.model.includes('nemotron')).every((c) => !c.thinkingOff));
  });

  test('if an endpoint rejects the toggle, the call is retried without it', async () => {
    behavior = (call) =>
      !call.model.includes('nemotron')
        ? { delayMs: 10, status: 500 }
        : call.thinkingOff
          ? { delayMs: 10, status: 400, error: 'Unknown field chat_template_kwargs' }
          : { delayMs: 10 };
    const result = await generateTweetsWithFallback(SOURCE);
    assert.equal(result.model, 'nvidia/nemotron-writer');
  });
});
