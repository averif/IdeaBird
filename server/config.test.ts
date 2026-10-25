import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

// Simulates a production deploy where the auth settings were never added.
process.env.VERCEL = '1';
delete process.env.DATABASE_URL;
delete process.env.JWT_SECRET;
delete process.env.APP_URL;

const { createApp } = await import('./app.js');

test('missing settings produce a clear JSON error instead of crashing the function', async () => {
  const app = createApp(); // must not throw: a throw here is FUNCTION_INVOCATION_FAILED on Vercel
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'long enough pw' }),
    });
    assert.equal(res.status, 503);
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /DATABASE_URL/);
    assert.match(error, /JWT_SECRET/);
    assert.match(error, /APP_URL/);
  } finally {
    server.close();
  }
});
