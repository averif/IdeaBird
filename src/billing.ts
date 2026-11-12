import { useEffect, useState } from 'react';
import type { BillingInterval, PlanId } from '../shared/plans';
import { apiJson, refreshSession } from './auth/client';
import type { ToastType, Usage } from './types';

/** The signed-in user's subscription (mirrors GET /api/billing). */
export interface BillingStatus {
  plan: PlanId;
  interval: BillingInterval | null;
  status: string | null;
  renewsAt: string | null;
  cancelsAtPeriodEnd: boolean;
  canManage: boolean;
  usage: Usage;
  /** Free's separate refine allowance; null on Pro (refines use generations). */
  refines: Usage | null;
}

/**
 * Upgrades via Dodo Payments: the server creates a checkout session for the
 * plan and billing period (the browser never picks a product), then we go to
 * Dodo's hosted checkout. Pro is granted only from Dodo's own records.
 */
export async function startCheckout(plan: PlanId, interval: BillingInterval): Promise<void> {
  const { checkoutUrl } = await apiJson<{ checkoutUrl: string }>('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan, interval }),
  });
  window.location.assign(checkoutUrl);
}

/** Dodo's customer portal: invoices, payment method, cancel. */
export async function openBillingPortal(): Promise<void> {
  const { url } = await apiJson<{ url: string }>('/api/billing/portal', { method: 'POST' });
  window.location.assign(url);
}

export function getBillingStatus(): Promise<BillingStatus> {
  return apiJson<BillingStatus>('/api/billing');
}

// Which billing periods can be bought (a Dodo product exists). Public, fetched once.
let optionsRequest: Promise<Record<BillingInterval, boolean>> | null = null;

export function useBillingOptions(): Record<BillingInterval, boolean> | null {
  const [options, setOptions] = useState<Record<BillingInterval, boolean> | null>(null);
  useEffect(() => {
    optionsRequest ??= fetch('/api/billing/options')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { intervals: Record<BillingInterval, boolean> }) => data.intervals)
      .catch(() => {
        optionsRequest = null;
        return { month: true, year: false };
      });
    let live = true;
    optionsRequest.then((value) => live && setOptions(value));
    return () => {
      live = false;
    };
  }, []);
  return options;
}

/**
 * Back from Dodo checkout: /?billing=return&subscription_id=sub_...&status=...
 * The redirect is only a hint. Ask the server to fetch the subscription from
 * Dodo, then refresh the session so the new plan shows everywhere.
 */
export function useCheckoutReturn(
  showToast: (message: string, type?: ToastType, duration?: number) => void,
  onReturn: () => void
) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') !== 'return') return;
    const subscriptionId = params.get('subscription_id');
    const status = params.get('status');
    window.history.replaceState(null, '', window.location.pathname);
    onReturn();

    if (!subscriptionId || status === 'failed' || status === 'expired') {
      showToast("The payment didn't go through, so you haven't been upgraded. You can try again anytime.", 'error', 7000);
      return;
    }
    apiJson<BillingStatus>('/api/billing/sync', { method: 'POST', body: JSON.stringify({ subscriptionId }) })
      .then(async (billing) => {
        await refreshSession();
        if (billing.plan === 'pro') showToast("Welcome to Pro. You're all set.", 'success', 6000);
        else showToast("Your payment is still processing. Pro turns on as soon as it's confirmed.", 'success', 7000);
      })
      .catch((err) => showToast(err instanceof Error ? err.message : "Couldn't confirm your upgrade yet.", 'error', 7000));
    // Runs once, on arrival.
  }, []);
}

// A visitor who taps "Upgrade to Pro" on the landing page signs up first; this
// remembers why (and which billing period they picked), so the app opens the
// Plans page on that period right after.
const INTENT_KEY = 'ib_upgrade_intent';

export function rememberUpgradeIntent(interval: BillingInterval): void {
  try {
    sessionStorage.setItem(INTENT_KEY, interval);
  } catch {
    // storage unavailable (private mode): they can still find Plans in the sidebar
  }
}

export function takeUpgradeIntent(): BillingInterval | null {
  try {
    const wanted = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    return wanted === 'month' || wanted === 'year' ? wanted : null;
  } catch {
    return null;
  }
}
