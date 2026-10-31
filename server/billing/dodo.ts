import DodoPayments from 'dodopayments';
import type { BillingInterval } from '../../shared/plans.js';
import { config } from '../config.js';
import { query } from '../db/index.js';

// Dodo Payments for IdeaBird Pro. The API key stays on the server; the browser
// only ever names a plan and a billing period, mapped here to an allowlisted product.

let client: DodoPayments | null = null;

export function dodo(): DodoPayments {
  const { apiKey, environment, webhookKey } = config().dodo;
  // DODO_PAYMENTS_BASE_URL (tests) and `environment` can't both be given.
  client ??= new DodoPayments({
    bearerToken: apiKey,
    webhookKey: webhookKey || null,
    ...(process.env.DODO_PAYMENTS_BASE_URL ? {} : { environment }),
  });
  return client;
}

/** The Dodo environment in use: stored IDs only count if they came from it. */
export function dodoMode(): 'test_mode' | 'live_mode' {
  return config().dodo.environment;
}

/**
 * SQL for a user's Dodo customer id, or NULL when it belongs to the other Dodo
 * environment (e.g. a test-mode customer once live mode is on). `$param` is the
 * placeholder holding dodoMode().
 */
export const customerIdSql = (param: string) => `CASE WHEN COALESCE(dodo_mode, 'test_mode') = ${param} THEN dodo_customer_id END`;

/** Billing periods that can be bought right now (a product is configured). */
export function availableIntervals(): Record<BillingInterval, boolean> {
  const { apiKey, products } = config().dodo;
  return { month: Boolean(apiKey && products.month), year: Boolean(apiKey && products.year) };
}

export function productFor(interval: BillingInterval): string {
  return config().dodo.products[interval];
}

export function intervalOf(productId: string): BillingInterval | null {
  const { products } = config().dodo;
  if (productId && productId === products.month) return 'month';
  if (productId && productId === products.year) return 'year';
  return null;
}

// Statuses that keep Pro. past_due is Dodo's grace period after a failed
// renewal: the customer keeps access until it ends or becomes on_hold.
const ENTITLED = new Set(['active', 'past_due']);

export class SubscriptionMismatch extends Error {}

interface UserBillingRow {
  id: string;
  /** NULL when the stored subscription is from the other Dodo environment. */
  dodo_subscription_id: string | null;
}

/**
 * Applies a subscription's CURRENT state, fetched from Dodo's API, to the user
 * it belongs to. Re-fetching (instead of trusting a webhook payload or the
 * checkout redirect) makes this safe to repeat and immune to out-of-order events.
 *
 * `forUserId` is set when a signed-in user asks to sync after checkout: the
 * subscription must then belong to them.
 */
export async function syncSubscription(subscriptionId: string, forUserId?: string): Promise<{ userId: string; plan: 'free' | 'pro' } | null> {
  const sub = await dodo().subscriptions.retrieve(subscriptionId);
  const interval = intervalOf(sub.product_id);
  if (!interval) return null; // not an IdeaBird Pro product

  const metadataUserId = typeof sub.metadata?.user_id === 'string' ? sub.metadata.user_id : '';
  const customerId = sub.customer?.customer_id || '';

  // Who owns it: the user id we put in the checkout metadata, else a user
  // already linked to this subscription or Dodo customer.
  const [owner] = await query<UserBillingRow>(
    `SELECT id, CASE WHEN COALESCE(dodo_mode, 'test_mode') = $4 THEN dodo_subscription_id END AS dodo_subscription_id
       FROM users
      WHERE ($1 <> '' AND id::text = $1)
         OR (COALESCE(dodo_mode, 'test_mode') = $4 AND (dodo_subscription_id = $2 OR ($3 <> '' AND dodo_customer_id = $3)))
      ORDER BY (id::text = $1) DESC, (dodo_subscription_id = $2) DESC
      LIMIT 1`,
    [metadataUserId, sub.subscription_id, customerId, dodoMode()]
  );
  if (!owner) return null;
  if (forUserId && owner.id !== forUserId) throw new SubscriptionMismatch('This subscription belongs to another account.');

  const entitled = ENTITLED.has(sub.status);
  // An old subscription ending must not downgrade a user who has since started a new one.
  if (!entitled && owner.dodo_subscription_id && owner.dodo_subscription_id !== sub.subscription_id) {
    return { userId: owner.id, plan: 'pro' };
  }

  const plan = entitled ? 'pro' : 'free';
  await query(
    `UPDATE users SET
       plan = $2, plan_interval = $3,
       dodo_customer_id = CASE WHEN $4 <> '' THEN $4
                               WHEN COALESCE(dodo_mode, 'test_mode') = $9 THEN dodo_customer_id END,
       dodo_subscription_id = $5, subscription_status = $6, plan_renews_at = $7,
       plan_cancels_at_period_end = $8, dodo_mode = $9, updated_at = now()
     WHERE id = $1`,
    [
      owner.id,
      plan,
      entitled ? interval : null,
      customerId,
      sub.subscription_id,
      sub.status,
      entitled && sub.next_billing_date ? new Date(sub.next_billing_date) : null,
      entitled && Boolean(sub.cancel_at_next_billing_date),
      dodoMode(),
    ]
  );
  console.log(`[IdeaBird] Billing: subscription ${sub.status} -> ${plan}`);
  return { userId: owner.id, plan };
}
