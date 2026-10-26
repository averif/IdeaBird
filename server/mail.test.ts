import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

// SMTP configured but unreachable (nothing listens on port 1): every send fails.
process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.APP_URL = 'http://localhost:5173';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_USER = 'sender@example.com';
process.env.SMTP_PASS = 'abcd efgh ijkl mnop';
delete process.env.RESEND_API_KEY;

const { createApp } = await import('./app.js');
const { config } = await import('./config.js');
const { mailDelivery } = await import('./mail.js');

let base = '';
let close: () => void;
before(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
};

test('SMTP is selected when SMTP_USER/SMTP_PASS are set, with spaces stripped from the app password', () => {
  assert.equal(mailDelivery(), 'smtp');
  assert.equal(config().smtp?.pass, 'abcdefghijklmnop');
  assert.equal(config().mailFrom, 'IdeaBird <sender@example.com>');
});

test('a failed send is reported to the user instead of claiming the code was sent', async () => {
  const r = await post('/api/auth/signup', { email: 'smtp-fail@example.com', password: 'long enough pw' });
  assert.equal(r.status, 502);
  assert.match(String(r.data.error), /couldn't send the verification email/);
});

test('forgot-password still answers generically when sending fails', async () => {
  const r = await post('/api/auth/forgot-password', { email: 'smtp-fail@example.com' });
  assert.equal(r.status, 200);
});
