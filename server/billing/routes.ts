import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { usageFor } from './usage.js';
import { activeOffer } from '../../shared/plans.js';
import { availableIntervals, customerIdSql, dodo, dodoMode, productFor, SubscriptionMismatch, syncSubscription } from './dodo.js';

export const billingRouter = Router();

interface BillingRow {
  plan: 'free' | 'pro';
  plan_interval: 'month' | 'year' | null;
  subscription_status: string | null;
  plan_renews_at: Date | string | null;
  plan_cancels_at_period_end: boolean;
  dodo_customer_id: string | null;
}

async function billingStatus(userId: string) {
  const [row] = await query<BillingRow>(
    `SELECT plan, plan_interval, subscription_status, plan_renews_at, plan_cancels_at_period_end, ${customerIdSql('$2')} AS dodo_customer_id
       FROM users WHERE id = $1`,
    [userId, dodoMode()]
  );
  return {
    plan: row?.plan ?? 'free',
    interval: row?.plan_interval ?? null,
    status: row?.subscription_status ?? null,
    renewsAt: row?.plan_renews_at ? new Date(row.plan_renews_at).toISOString() : null,
    cancelsAtPeriodEnd: Boolean(row?.plan_cancels_at_period_end),
    /** A Dodo customer exists, so the billing portal can open. */
    canManage: Boolean(row?.dodo_customer_id),
    usage: await usageFor(userId, row?.plan ?? 'free'),
  };
}

function dodoFailure(err: unknown, what: string): HttpError {
  // Dodo's error bodies can include account details: log the status only.
  const status = (err as { status?: number }).status;
  console.error(`[IdeaBird] Dodo ${what} failed${status ? ` (HTTP ${status})` : ''}.`);
  return new HttpError(502, "Couldn't reach the payment provider. Please try again in a moment.");
}

/** Public: which billing periods can be bought, so the pricing page only offers those. */
billingRouter.get('/options', (_req, res) => {
  res.json({ intervals: availableIntervals() });
});

billingRouter.get('/', requireAuth, async (req, res) => {
  res.json(await billingStatus(currentUser(req).id));
});

/** Creates a Dodo checkout session for Pro and returns its hosted URL. */
billingRouter.post('/checkout', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const { interval } = parseBody(z.object({ plan: z.literal('pro'), interval: z.enum(['month', 'year']) }), req.body);
  if (!availableIntervals()[interval]) {
    throw new HttpError(503, interval === 'year' ? 'Yearly billing isn’t available yet. Choose monthly.' : 'Upgrading isn’t available yet.');
  }
  await rateLimit({ key: `checkout:${user.id}`, max: 10, windowSeconds: 60 * 60, message: 'Too many checkout attempts. Try again later.' });

  const status = await billingStatus(user.id);
  if (status.plan === 'pro') throw new HttpError(409, "You're already on Pro. Manage your plan from Billing.");

  const [row] = await query<{ dodo_customer_id: string | null }>(`SELECT ${customerIdSql('$2')} AS dodo_customer_id FROM users WHERE id = $1`, [
    user.id,
    dodoMode(),
  ]);
  const createSession = (discountCode: string | null) =>
    dodo().checkoutSessions.create({
      product_cart: [{ product_id: productFor(interval), quantity: 1 }],
      // Reuse the Dodo customer after a past subscription; otherwise Dodo creates one.
      customer: row?.dodo_customer_id ? { customer_id: row.dodo_customer_id } : { email: user.email, ...(user.name ? { name: user.name } : {}) },
      // Ties the subscription to this account; read back server-side, never trusted from the browser.
      metadata: { user_id: user.id },
      return_url: `${config().appUrl}/?billing=return`,
      // The launch discount, pre-applied (shared/plans.ts). Dodo shows it on the checkout page.
      ...(discountCode ? { discount_codes: [discountCode] } : {}),
    });

  // Never let the offer block an upgrade: if Dodo rejects the code (expired,
  // used up, changed), check out at full price instead.
  const offer = activeOffer(interval);
  let session;
  let discounted = false;
  try {
    if (offer) {
      session = await createSession(offer.code).catch((err) => {
        const status = (err as { status?: number }).status;
        console.warn(`[IdeaBird] Dodo rejected discount ${offer.code}${status ? ` (HTTP ${status})` : ''}; checking out at full price.`);
        return null;
      });
      discounted = Boolean(session);
    }
    session ??= await createSession(null);
    if (!session.checkout_url) throw new Error('No checkout URL');
  } catch (err) {
    throw dodoFailure(err, 'checkout');
  }
  res.json({ checkoutUrl: session.checkout_url, discount: discounted ? offer!.code : null });
});

/**
 * After checkout, Dodo sends the browser back with ?subscription_id=. That
 * redirect proves nothing, so this fetches the subscription from Dodo and
 * applies its real status (only if it belongs to the signed-in user).
 */
billingRouter.post('/sync', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const { subscriptionId } = parseBody(z.object({ subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/).max(64) }), req.body);
  await rateLimit({ key: `billing-sync:${user.id}`, max: 30, windowSeconds: 60 * 60 });
  try {
    await syncSubscription(subscriptionId, user.id);
  } catch (err) {
    if (err instanceof SubscriptionMismatch) throw new HttpError(403, err.message);
    throw dodoFailure(err, 'subscription lookup');
  }
  res.json(await billingStatus(user.id));
});

/** Dodo's hosted portal: invoices, payment method, cancel. */
billingRouter.post('/portal', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const [row] = await query<{ dodo_customer_id: string | null }>(`SELECT ${customerIdSql('$2')} AS dodo_customer_id FROM users WHERE id = $1`, [
    user.id,
    dodoMode(),
  ]);
  if (!row?.dodo_customer_id) throw new HttpError(404, 'There is no billing account yet.');
  try {
    const session = await dodo().customers.customerPortal.create(row.dodo_customer_id);
    res.json({ url: session.link });
  } catch (err) {
    throw dodoFailure(err, 'portal');
  }
});

/**
 * Dodo webhooks (raw body, see app.ts). The signature is verified, then the
 * subscription is re-fetched and applied, so retries and out-of-order deliveries
 * converge on Dodo's current state. Non-2xx makes Dodo retry.
 */
export async function handleWebhook(req: Request): Promise<{ status: number; body: unknown }> {
  if (!config().dodo.webhookKey) return { status: 503, body: { error: 'Webhooks are not configured.' } };

  let event: { type: string; data: Record<string, unknown> };
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    event = dodo().webhooks.unwrap(raw, {
      headers: {
        'webhook-id': req.get('webhook-id') || '',
        'webhook-signature': req.get('webhook-signature') || '',
        'webhook-timestamp': req.get('webhook-timestamp') || '',
      },
    }) as unknown as typeof event;
  } catch {
    return { status: 401, body: { error: 'Invalid signature.' } };
  }

  const subscriptionId = typeof event.data?.subscription_id === 'string' ? event.data.subscription_id : '';
  if (event.type.startsWith('subscription.') && subscriptionId) {
    try {
      await syncSubscription(subscriptionId);
    } catch (err) {
      console.error(`[IdeaBird] Webhook ${event.type} could not be applied; Dodo will retry.`, (err as Error).message);
      return { status: 500, body: { error: 'Retry later.' } };
    }
  }
  return { status: 200, body: { received: true } };
}

billingRouter.post('/webhook', async (req, res) => {
  const { status, body } = await handleWebhook(req);
  res.status(status).json(body);
});
