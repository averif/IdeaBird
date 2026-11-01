import { useEffect, useState } from 'react';
import { PLANS, type BillingInterval, type PlanId } from '../../shared/plans';
import { useAuth } from '../auth/AuthContext';
import { getBillingStatus, openBillingPortal, startCheckout, type BillingStatus } from '../billing';
import type { ToastType } from '../types';
import { PricingPlans } from './PricingPlans';
import type { Page } from './Sidebar';

interface PlansPageProps {
  active: boolean;
  /** Billing period picked on the landing page before signing up. */
  initialInterval?: BillingInterval;
  onNavigate: (page: Page) => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** In-app pricing: the user's current plan, upgrade via Dodo checkout, and billing management. */
export function PlansPage({ active, initialInterval, onNavigate, showToast }: PlansPageProps) {
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

      {isPro ? (
        <ProFeatures usage={billing?.usage ?? null} onNavigate={onNavigate} />
      ) : (
        // Mounted only while visible, so the entrance animation plays each time.
        active && (
        <PricingPlans
          context="app"
          currentPlan={plan}
          initialInterval={initialInterval}
          onSelect={select}
          busyPlan={busy === 'portal' ? null : busy}
        />
        )
      )}
    </section>
  );
}

interface ProFeaturesProps {
  usage: BillingStatus['usage'] | null;
  onNavigate: (page: Page) => void;
}

/** What a Pro subscriber has, and where to find each feature. Replaces the pricing cards. */
function ProFeatures({ usage, onNavigate }: ProFeaturesProps) {
  const { limits } = PLANS.pro;
  const features: { title: string; detail: string; link?: { label: string; page: Page } }[] = [
    {
      title: `${limits.generationsPerMonth.toLocaleString('en-US')} AI generations a month`,
      detail: usage
        ? `${Math.max(0, usage.limit - usage.used).toLocaleString('en-US')} left this month. Resets on the 1st.`
        : 'Resets on the 1st of every month.',
      link: { label: 'New post', page: 'create' },
    },
    {
      title: `${limits.draftsPerGeneration} post variations per generation`,
      detail: 'A hot take, a question, a stat-led post, a thread and a LinkedIn version of every screenshot.',
    },
    {
      title: 'Saved drafts and generation history',
      detail: 'Every generation is saved, so you can come back to a draft later.',
      link: { label: 'Open History', page: 'history' },
    },
    {
      title: 'Custom tone and writing instructions',
      detail: 'Pick a tone and add standing instructions IdeaBird follows on every post.',
      link: { label: 'Set in Settings', page: 'settings' },
    },
    {
      title: 'X thread expansion',
      detail: 'Turn any draft into a numbered X thread with "Expand into thread".',
    },
    {
      title: 'Refine your own posts',
      detail: 'Paste a rough thought or a post and get back something eloquent, wise and worth quoting.',
      link: { label: 'Open Refine', page: 'refine' },
    },
  ];

  return (
    <div className="pro-features">
      <h3>Everything in your plan</h3>
      <ul>
        {features.map((f) => (
          <li key={f.title}>
            <svg className="pro-features-check" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
            <div>
              <strong>{f.title}</strong>
              <p>{f.detail}</p>
            </div>
            {f.link && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onNavigate(f.link!.page)}>
                {f.link.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
