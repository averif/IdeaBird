import { useEffect, useState } from 'react';
import type { BillingInterval, PlanId } from '../../shared/plans';
import { useAuth } from '../auth/AuthContext';
import { getBillingStatus, openBillingPortal, startCheckout, type BillingStatus } from '../billing';
import type { ToastType } from '../types';
import { PricingPlans } from './PricingPlans';

interface PlansPageProps {
  active: boolean;
  /** Billing period picked on the landing page before signing up. */
  initialInterval?: BillingInterval;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** In-app pricing: the user's current plan, upgrade via Dodo checkout, and billing management. */
export function PlansPage({ active, initialInterval, showToast }: PlansPageProps) {
  const { user } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState<PlanId | 'portal' | null>(null);
  const plan = user?.plan ?? 'free';

  // Reload whenever the page opens or the plan changes (e.g. after checkout).
  useEffect(() => {
    if (!active) return;
    getBillingStatus().then(setBilling).catch(() => setBilling(null));
  }, [active, plan]);

  const run = async (key: PlanId | 'portal', action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action(); // navigates away on success
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong. Please try again.', 'error', 6000);
      setBusy(null);
    }
  };

  const select = (target: PlanId, interval: BillingInterval) => {
    if (target === 'free') return;
    run(target, () => startCheckout(target, interval));
  };

  const isPro = plan === 'pro';

  return (
    <section className={`step step-plans${active ? ' active' : ''}`} id="step-plans">
      <div className="page-head">
        <div>
          <h2>Plans</h2>
          <p>
            {isPro ? 'Thanks for supporting IdeaBird.' : 'More generations, every variation, and your full history.'}
            {billing?.usage && ` You've used ${billing.usage.used} of ${billing.usage.limit.toLocaleString('en-US')} generations this month.`}
          </p>
        </div>
      </div>

      {isPro && (
        <div className="plan-status">
          <div>
            <strong>
              You're on Pro{billing?.interval ? `, billed ${billing.interval === 'year' ? 'yearly' : 'monthly'}` : ''}
            </strong>
            <p>
              {billing?.status === 'past_due'
                ? 'Your last payment failed. Update your payment method to keep Pro.'
                : billing?.renewsAt
                  ? billing.cancelsAtPeriodEnd
                    ? `Pro ends on ${date(billing.renewsAt)}. You won't be charged again.`
                    : `Renews on ${date(billing.renewsAt)}.`
                  : 'Your subscription is active.'}
            </p>
          </div>
          {billing?.canManage && (
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy !== null} onClick={() => run('portal', openBillingPortal)}>
              {busy === 'portal' ? 'Opening...' : 'Manage billing'}
            </button>
          )}
        </div>
      )}

      {/* Mounted only while visible, so the entrance animation plays each time. */}
      {active && (
        <PricingPlans
          context="app"
          currentPlan={plan}
          initialInterval={initialInterval}
          onSelect={select}
          busyPlan={busy === 'portal' ? null : busy}
        />
      )}
    </section>
  );
}
