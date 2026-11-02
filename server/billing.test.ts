import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

// --- Fake Dodo Payments API ---------------------------------------------------------
interface FakeSub {
  subscription_id: string;
  status: string;
  product_id: string;
  customer: { customer_id: string; email: string; name: string };
  metadata: Record<string, string>;
  next_billing_date: string;
  cancel_at_next_billing_date: boolean;
}

const dodo = {
  subs: new Map<string, FakeSub>(),
  checkouts: [] as Record<string, unknown>[],
  portalFor: [] as string[],
  failCheckout: false,
  /** Dodo answers a checkout that carries a discount code with 422 (expired or used-up code). */
  rejectDiscount: false,
};

const fakeDodo = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://dodo');
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer test-dodo-key') return send(401, { message: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/checkouts') {
      if (dodo.failCheckout) return send(500, { message: 'internal error for merchant acct_123' });
      const parsed = JSON.parse(body);
      if (dodo.rejectDiscount && parsed.discount_codes?.length) return send(422, { message: 'discount code expired' });
      dodo.checkouts.push(parsed);
      return send(200, { session_id: `cks_${dodo.checkouts.length}`, checkout_url: `https://test.checkout.dodopayments.com/session/cks_${dodo.checkouts.length}` });
    }
    const sub = /^\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && sub) {
      const found = dodo.subs.get(sub[1]);
      return found ? send(200, found) : send(404, { message: 'not found' });
    }
    const portal = /^\/customers\/([^/]+)\/customer-portal\/session$/.exec(url.pathname);
    if (req.method === 'POST' && portal) {
      dodo.portalFor.push(portal[1]);
      return send(200, { link: `https://test.customer.dodopayments.com/${portal[1]}` });
    }
    send(404, { message: 'no route' });
  });
});
await new Promise<void>((resolve) => fakeDodo.listen(0, resolve));

const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('base64')}`;

process.env.DATABASE_URL = 'pglite:memory';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.APP_URL = 'http://localhost:5173';
process.env.DODO_PAYMENTS_API_KEY = 'test-dodo-key';
process.env.DODO_PAYMENTS_ENVIRONMENT = 'test_mode';
process.env.DODO_PAYMENTS_BASE_URL = `http://127.0.0.1:${(fakeDodo.address() as AddressInfo).port}`;
process.env.DODO_PRODUCT_ID = 'pdt_pro_monthly';
delete process.env.DODO_PRODUCT_ID_YEARLY;
process.env.DODO_PAYMENTS_WEBHOOK_KEY = WEBHOOK_SECRET;

const { createApp } = await import('./app.js');
const { query } = await import('./db/index.js');
const { signAccessToken } = await import('./auth/tokens.js');
const { activeOffer, LAUNCH_OFFER } = await import('../shared/plans.js');

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
  fakeDodo.close();
});

beforeEach(async () => {
  dodo.subs.clear();
  dodo.checkouts = [];
  dodo.portalFor = [];
  dodo.failCheckout = false;
  dodo.rejectDiscount = false;
  await query(`DELETE FROM rate_limits`);
});

let n = 0;
async function makeUser() {
  const email = `buyer${++n}-${Date.now()}@example.com`;
  const [row] = await query<{ id: string }>(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Buyer', true) RETURNING id`, [email]);
  return { id: row.id, email, token: await signAccessToken({ sub: row.id, ver: 0 }) };
}
type User = Awaited<ReturnType<typeof makeUser>>;

async function api(method: string, path: string, { user, body, headers = {}, raw }: { user?: User; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown>, text };
}

function addSub(id: string, user: User | null, status: string, extra: Partial<FakeSub> = {}) {
  dodo.subs.set(id, {
    subscription_id: id,
    status,
    product_id: 'pdt_pro_monthly',
    customer: { customer_id: `cus_${user?.id.slice(0, 8) ?? 'stranger'}`, email: user?.email ?? 'x@example.com', name: 'Buyer' },
    metadata: user ? { user_id: user.id } : {},
    next_billing_date: '2026-12-01T00:00:00Z',
    cancel_at_next_billing_date: false,
    ...extra,
  });
}

/** Signs a payload the way Dodo does (Standard Webhooks). */
function signedWebhook(event: unknown) {
  const raw = JSON.stringify(event);
  const id = `msg_${randomBytes(6).toString('hex')}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return { raw, headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } };
}

const planOf = async (user: User) => (await api('GET', '/api/billing', { user })).data.plan;

describe('checkout', () => {
  test('only offers billing periods that have a product', async () => {
    const r = await api('GET', '/api/billing/options');
    assert.deepEqual(r.data, { intervals: { month: true, year: false } });
  });

  test('creates a Dodo checkout for the allowlisted product, tied to the user', async () => {
    assert.equal((await api('POST', '/api/billing/checkout', { body: { plan: 'pro', interval: 'month' } })).status, 401);

    const user = await makeUser();
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month', product_id: 'pdt_attacker' } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.data.checkoutUrl as string, /^https:\/\/test\.checkout\.dodopayments\.com\//);

    const sent = dodo.checkouts[0] as { product_cart: { product_id: string; quantity: number }[]; metadata: Record<string, string>; customer: { email: string }; return_url: string };
    assert.deepEqual(sent.product_cart, [{ product_id: 'pdt_pro_monthly', quantity: 1 }]);
    assert.equal(sent.metadata.user_id, user.id);
    assert.equal(sent.customer.email, user.email);
    assert.equal(sent.return_url, 'http://localhost:5173/?billing=return');
    // The API key never reaches the browser.
    assert.doesNotMatch(r.text, /test-dodo-key/);
  });

  test('yearly is refused while no yearly product exists', async () => {
    const user = await makeUser();
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'year' } });
    assert.equal(r.status, 503);
    assert.equal(dodo.checkouts.length, 0);
  });

  test('the launch discount is applied automatically to monthly checkouts', async () => {
    const user = await makeUser();
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month' } });
    assert.equal(r.status, 200, r.text);
    const offer = activeOffer('month');
    const sent = dodo.checkouts[0] as { discount_codes?: string[] };
    // Once the offer has ended, checkouts go through at full price with no code.
    assert.deepEqual(sent.discount_codes, offer ? [offer.code] : undefined);
    assert.equal(r.data.discount, offer ? offer.code : null);
  });

  test("a code Dodo rejects doesn't block the upgrade: it checks out at full price", async () => {
    const user = await makeUser();
    dodo.rejectDiscount = true;
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.discount, null);
    assert.equal(dodo.checkouts.length, 1);
    assert.equal((dodo.checkouts[0] as { discount_codes?: string[] }).discount_codes, undefined);
  });

  test("a Dodo failure is reported without leaking Dodo's error text", async () => {
    const user = await makeUser();
    dodo.failCheckout = true;
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month' } });
    assert.equal(r.status, 502);
    assert.doesNotMatch(r.text, /acct_123/);
  });
});

describe('after checkout', () => {
  test('Pro is granted from the subscription Dodo reports, not from the redirect', async () => {
    const user = await makeUser();
    assert.equal(await planOf(user), 'free');

    // Still pending at Dodo: no Pro yet, whatever the redirect said.
    addSub('sub_1', user, 'pending');
    let r = await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_1' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.plan, 'free');

    addSub('sub_1', user, 'active');
    r = await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_1' } });
    assert.equal(r.data.plan, 'pro');
    assert.equal(r.data.interval, 'month');
    assert.equal(r.data.renewsAt, '2026-12-01T00:00:00.000Z');
    assert.equal(r.data.canManage, true);

    // The session shows it too.
    const [row] = await query<{ plan: string }>(`SELECT plan FROM users WHERE id = $1`, [user.id]);
    assert.equal(row.plan, 'pro');
  });

  test("someone else's subscription can't be claimed", async () => {
    const owner = await makeUser();
    const thief = await makeUser();
    addSub('sub_2', owner, 'active');
    const r = await api('POST', '/api/billing/sync', { user: thief, body: { subscriptionId: 'sub_2' } });
    assert.equal(r.status, 403);
    assert.equal(await planOf(thief), 'free');
  });

  test("subscriptions for other products don't grant Pro", async () => {
    const user = await makeUser();
    addSub('sub_3', user, 'active', { product_id: 'pdt_something_else' });
    await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_3' } });
    assert.equal(await planOf(user), 'free');
  });

  test('a Pro user is sent to Billing instead of a second checkout', async () => {
    const user = await makeUser();
    addSub('sub_4', user, 'active');
    await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_4' } });
    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month' } });
    assert.equal(r.status, 409);
  });

  test('the billing portal opens for customers only', async () => {
    const user = await makeUser();
    assert.equal((await api('POST', '/api/billing/portal', { user })).status, 404);
    addSub('sub_5', user, 'active');
    await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_5' } });
    const r = await api('POST', '/api/billing/portal', { user });
    assert.equal(r.status, 200);
    assert.match(r.data.url as string, /^https:\/\/test\.customer\.dodopayments\.com\/cus_/);
  });
});

describe('test and live mode', () => {
  test("IDs saved under the other Dodo environment are never sent to Dodo", async () => {
    // This suite runs in test_mode; pretend this customer came from live_mode.
    const user = await makeUser();
    await query(`UPDATE users SET dodo_customer_id = 'cus_from_live', dodo_mode = 'live_mode' WHERE id = $1`, [user.id]);

    assert.equal((await api('GET', '/api/billing', { user })).data.canManage, false);
    assert.equal((await api('POST', '/api/billing/portal', { user })).status, 404);

    const r = await api('POST', '/api/billing/checkout', { user, body: { plan: 'pro', interval: 'month' } });
    assert.equal(r.status, 200, r.text);
    const sent = dodo.checkouts[0] as { customer: Record<string, string> };
    assert.equal(sent.customer.customer_id, undefined);
    assert.equal(sent.customer.email, user.email);
  });

  test('subscribing in the current mode replaces the old IDs', async () => {
    const user = await makeUser();
    await query(`UPDATE users SET dodo_customer_id = 'cus_from_live', dodo_subscription_id = 'sub_from_live', dodo_mode = 'live_mode' WHERE id = $1`, [user.id]);
    addSub('sub_9', user, 'active');
    await api('POST', '/api/billing/sync', { user, body: { subscriptionId: 'sub_9' } });
    const [row] = await query<{ dodo_mode: string; dodo_subscription_id: string; plan: string }>(
      `SELECT dodo_mode, dodo_subscription_id, plan FROM users WHERE id = $1`,
      [user.id]
    );
    assert.deepEqual(row, { dodo_mode: 'test_mode', dodo_subscription_id: 'sub_9', plan: 'pro' });
  });
});

describe('webhooks', () => {
  test('rejects unsigned or tampered events', async () => {
    const user = await makeUser();
    addSub('sub_6', user, 'active');
    const event = { type: 'subscription.active', data: { subscription_id: 'sub_6' } };

    assert.equal((await api('POST', '/api/billing/webhook', { raw: JSON.stringify(event) })).status, 401);
    const signed = signedWebhook(event);
    const tampered = await api('POST', '/api/billing/webhook', { raw: signed.raw.replace('sub_6', 'sub_7'), headers: signed.headers });
    assert.equal(tampered.status, 401);
    assert.equal(await planOf(user), 'free');
  });

  test('follows the subscription through renewal trouble and cancellation', async () => {
    const user = await makeUser();
    const deliver = async (type: string, status: string) => {
      addSub('sub_8', user, status);
      const { raw, headers } = signedWebhook({ type, data: { subscription_id: 'sub_8', status } });
      const r = await api('POST', '/api/billing/webhook', { raw, headers });
      assert.equal(r.status, 200, r.text);
      return planOf(user);
    };

    assert.equal(await deliver('subscription.active', 'active'), 'pro');
    // Grace period after a failed renewal keeps access.
    assert.equal(await deliver('subscription.past_due', 'past_due'), 'pro');
    assert.equal(await deliver('subscription.on_hold', 'on_hold'), 'free');
    assert.equal(await deliver('subscription.renewed', 'active'), 'pro');
    assert.equal(await deliver('subscription.cancelled', 'cancelled'), 'free');
  });

  test('a late event for an old subscription does not downgrade a newer one', async () => {
    const user = await makeUser();
    addSub('sub_old', user, 'cancelled');
    addSub('sub_new', user, 'active');
    const send = async (id: string) => {
      const { raw, headers } = signedWebhook({ type: 'subscription.updated', data: { subscription_id: id } });
      return api('POST', '/api/billing/webhook', { raw, headers });
    };
    await send('sub_new');
    assert.equal(await planOf(user), 'pro');
    await send('sub_old');
    assert.equal(await planOf(user), 'pro');
  });

  test('payment events are acknowledged and ignored', async () => {
    const { raw, headers } = signedWebhook({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } });
    assert.equal((await api('POST', '/api/billing/webhook', { raw, headers })).status, 200);
  });
});

describe('launch offer', () => {
  test('is monthly-only and ends when the Dodo code expires', () => {
    if (!LAUNCH_OFFER) return;
    const before = new Date(Date.parse(LAUNCH_OFFER.endsAt) - 60_000);
    const afterEnd = new Date(Date.parse(LAUNCH_OFFER.endsAt) + 60_000);
    assert.equal(activeOffer('month', before)?.code, LAUNCH_OFFER.code);
    assert.equal(activeOffer('year', before), null);
    assert.equal(activeOffer('month', afterEnd), null);
  });
});
