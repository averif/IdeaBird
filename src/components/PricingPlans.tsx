import { useEffect, useRef, useState } from 'react';
import {
  activeOffer,
  BILLING,
  COMING_SOON,
  formatPrice,
  offerPrice,
  PLAN_ORDER,
  PLANS,
  pricePerMonth,
  yearlySavingsPercent,
  type BillingInterval,
  type Plan,
  type PlanId,
} from '../../shared/plans';
import { useBillingOptions } from '../billing';
import './pricing.css';

// Every line below is derived from shared/plans.ts, so changing a price or a
// limit there updates the cards and the comparison everywhere.

const FORMATS = ['Hot take', 'Question', 'Stat-lead', 'Thread', 'LinkedIn'];

type Cell = boolean | string | 'soon';

interface Row {
  label: string;
  hint?: string;
  value: (plan: Plan) => Cell;
}

const number = (n: number) => n.toLocaleString('en-US');

const ROWS: Row[] = [
  { label: 'AI generations', hint: 'per month', value: (p) => number(p.limits.generationsPerMonth) },
  { label: 'Drafts per generation', value: (p) => String(p.limits.draftsPerGeneration) },
  {
    label: 'Post formats',
    value: (p) => (p.limits.draftsPerGeneration > 1 ? FORMATS.slice(0, p.limits.draftsPerGeneration).join(', ') : 'Single best post'),
  },
  { label: 'Vision analysis and angles', value: () => true },
  { label: 'Exact numbers, never invented', value: () => true },
  { label: 'Custom tone and writing instructions', value: (p) => soon(p.limits.customVoice, 'customVoice') },
  { label: 'Write Like Me', hint: 'learns your voice from X', value: (p) => soon(p.limits.writeLikeMe, 'writeLikeMe') },
  { label: 'Saved drafts and history', value: (p) => p.limits.history },
  { label: 'X thread expansion', value: (p) => soon(p.limits.threadExpansion, 'threadExpansion') },
  {
    label: 'Refine your own posts',
    hint: 'X and LinkedIn',
    // Free: its own monthly number. Pro: uses generations, so effectively the full allowance.
    value: (p) => (p.limits.refinesPerMonth !== null ? `${number(p.limits.refinesPerMonth)} a month` : soon(p.limits.refine, 'refine')),
  },
];

/** An included feature that isn't built yet shows as "Coming soon". */
function soon(included: boolean, key: keyof Plan['limits']): Cell {
  return included && COMING_SOON[key] ? 'soon' : included;
}

/** The short list on each card: what this plan is, in plain words. */
function highlights(plan: Plan): { text: string; included: boolean; soon?: boolean }[] {
  const { limits } = plan;
  return [
    { text: `${number(limits.generationsPerMonth)} AI generations a month`, included: true },
    {
      text: limits.draftsPerGeneration > 1 ? `${limits.draftsPerGeneration} post variations per generation` : 'One default post per generation',
      included: true,
    },
    { text: 'Saved drafts and generation history', included: limits.history },
    { text: 'Custom tone and writing instructions', included: limits.customVoice, soon: limits.customVoice && COMING_SOON.customVoice },
    { text: 'Write Like Me: posts in your own voice', included: limits.writeLikeMe, soon: limits.writeLikeMe && COMING_SOON.writeLikeMe },
    { text: 'X thread expansion', included: limits.threadExpansion, soon: limits.threadExpansion && COMING_SOON.threadExpansion },
    {
      text: limits.refinesPerMonth !== null ? `${number(limits.refinesPerMonth)} post refines a month` : 'Refine your own X and LinkedIn posts',
      included: limits.refine,
      soon: limits.refine && COMING_SOON.refine,
    },
  ];
}

const Check = () => (
  <svg className="pr-icon pr-yes" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const Dash = () => (
  <svg className="pr-icon pr-no" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 12h10" />
  </svg>
);
const Arrow = () => (
  <svg className="pr-arrow" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </svg>
);

function CellValue({ cell }: { cell: Cell }) {
  if (cell === 'soon') return <span className="pr-soon">Coming soon</span>;
  if (cell === true) return <><Check /><span className="sr-only">Included</span></>;
  if (cell === false) return <><Dash /><span className="sr-only">Not included</span></>;
  return <span>{cell}</span>;
}

/** Plays the entrance animation once the plans scroll into view. */
function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || !('IntersectionObserver' in window)) return setInView(true);
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    }, { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, inView] as const;
}

interface PricingPlansProps {
  /** Landing: invite sign-up. App: show the user's current plan. */
  context: 'landing' | 'app';
  currentPlan?: PlanId;
  onSelect: (plan: PlanId, interval: BillingInterval) => void;
  /** Billing period shown first (e.g. the one picked on the landing page). */
  initialInterval?: BillingInterval;
  /** The plan whose button is waiting on checkout. */
  busyPlan?: PlanId | null;
  /** The full comparison table under the cards. */
  showComparison?: boolean;
}

export function PricingPlans({
  context,
  currentPlan,
  onSelect,
  initialInterval = BILLING.defaultInterval,
  busyPlan = null,
  showComparison = true,
}: PricingPlansProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [chosenInterval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  // Yearly is offered only once a yearly product exists in Dodo.
  const options = useBillingOptions();
  const yearly = options?.year ?? false;
  const interval: BillingInterval = yearly ? chosenInterval : 'month';
  const free = PLANS.free;
  const pro = PLANS.pro;
  const moreGenerations = Math.round(pro.limits.generationsPerMonth / Math.max(1, free.limits.generationsPerMonth));
  const savings = yearlySavingsPercent(pro);

  // Launch discount (shared/plans.ts), applied automatically at checkout.
  const offer = activeOffer(interval);
  const monthlyOffer = activeOffer('month');

  const priceNote = (plan: Plan) => {
    if (plan.monthlyPrice === 0) return 'No card needed.';
    if (interval === 'year') return `Billed ${formatPrice(plan.yearlyPrice)} once a year.${savings ? ` You save ${savings}%.` : ''}`;
    return `${moreGenerations}× the generations of Free, every month.`;
  };

  const cta = (plan: Plan) => {
    if (currentPlan === plan.id) return { label: 'Your current plan', disabled: true };
    if (plan.monthlyPrice === 0) return { label: context === 'landing' ? 'Start for free' : 'Included', disabled: context !== 'landing' };
    return { label: busyPlan === plan.id ? 'Opening checkout...' : `Upgrade to ${plan.name}`, disabled: busyPlan !== null };
  };

  return (
    <div className={`pr${inView ? ' in' : ''}`} ref={ref}>
      <div className="pr-billing">
        {yearly ? (
        <div className="pr-toggle" role="radiogroup" aria-label="Billing period" data-interval={interval}>
          <span className="pr-toggle-thumb" aria-hidden="true" />
          {(['month', 'year'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={interval === option}
              className={`pr-toggle-opt${interval === option ? ' active' : ''}`}
              onClick={() => setBillingInterval(option)}
            >
              {option === 'month' ? 'Monthly' : 'Yearly'}
              {option === 'year' && savings > 0 && <span className="pr-save">−{savings}%</span>}
            </button>
          ))}
        </div>
        ) : (
          <span className="pr-billing-pill">Monthly</span>
        )}
        <p>
          {interval === 'year' ? 'Billed once a year' : 'Billed monthly'} in {BILLING.currency}. Cancel anytime from Billing.
          {/* The launch discount is monthly-only: point to it from the yearly view. */}
          {interval === 'year' && monthlyOffer && currentPlan !== 'pro' && (
            <> Launch offer: {monthlyOffer.percentOff}% off your first {monthlyOffer.cycles} months on monthly billing.</>
          )}
        </p>
      </div>

      <div className="pr-cards">
        {PLAN_ORDER.map((id, index) => {
          const plan = PLANS[id];
          const featured = plan.monthlyPrice > 0;
          const action = cta(plan);
          const planOffer = featured && currentPlan !== plan.id ? offer : null;
          const note = planOffer ? null : priceNote(plan);
          return (
            <article
              key={plan.id}
              className={`pr-card${featured ? ' pr-card-featured' : ''}`}
              style={{ ['--pr-delay' as string]: `${index * 90}ms` }}
              aria-labelledby={`pr-${plan.id}-name`}
            >
              <header className="pr-card-head">
                <h3 id={`pr-${plan.id}-name`}>{plan.name}</h3>
                {featured && <span className="pr-tag">Best for creators</span>}
                {currentPlan === plan.id && !featured && <span className="pr-tag pr-tag-muted">Current</span>}
              </header>
              <p className="pr-tagline">{plan.tagline}</p>

              <p className="pr-price">
                {/* Keyed so the figure animates when the billing period changes. */}
                <span className="pr-amount" key={`${plan.id}-${interval}`}>
                  {formatPrice(planOffer ? offerPrice(plan, planOffer) : pricePerMonth(plan, interval))}
                </span>
                <span className="pr-per">/ month</span>
                {featured && (planOffer || (interval === 'year' && plan.monthlyPrice > pricePerMonth(plan, interval))) && (
                  <s className="pr-was" aria-label={`instead of ${formatPrice(plan.monthlyPrice)}`}>{formatPrice(plan.monthlyPrice)}</s>
                )}
              </p>
              {note && <p className="pr-price-note">{note}</p>}
              {planOffer && (
                <div className="pr-offer">
                  <span className="pr-offer-tag">Launch offer · {planOffer.code}</span>
                  <p>
                    <strong>
                      {planOffer.percentOff}% off your first {planOffer.cycles} months
                    </strong>{' '}
                    ({formatPrice(offerPrice(plan, planOffer))} a month). From month {planOffer.cycles + 1} it's{' '}
                    {formatPrice(plan.monthlyPrice)} a month. Applied automatically at checkout.
                  </p>
                </div>
              )}

              <button
                type="button"
                className={`pr-btn ${featured ? 'pr-btn-primary' : 'pr-btn-outline'}`}
                disabled={action.disabled}
                onClick={() => onSelect(plan.id, interval)}
              >
                {featured && <span className="pr-btn-square" aria-hidden="true" />}
                {action.label}
                {featured && !action.disabled && <Arrow />}
              </button>

              <ul className="pr-list">
                {highlights(plan).map((item, i) => (
                  <li key={item.text} className={item.included ? '' : 'pr-off'} style={{ ['--pr-i' as string]: i }}>
                    {item.included ? <Check /> : <Dash />}
                    <span>
                      {item.text}
                      {item.soon && <span className="pr-soon">Coming soon</span>}
                      {!item.included && <span className="sr-only"> (not included)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>

      {showComparison && (
      <div className="pr-compare" role="table" aria-label="Compare plans">
        <div className="pr-row pr-row-head" role="row">
          <span role="columnheader" className="pr-mono">Compare plans</span>
          {PLAN_ORDER.map((id) => (
            <span role="columnheader" key={id} className={PLANS[id].monthlyPrice > 0 ? 'pr-col-featured' : ''}>
              {PLANS[id].name}
            </span>
          ))}
        </div>
        {ROWS.map((row) => (
          <div className="pr-row" role="row" key={row.label}>
            <span role="rowheader" className="pr-row-label">
              {row.label}
              {row.hint && <small> {row.hint}</small>}
            </span>
            {PLAN_ORDER.map((id) => (
              <span role="cell" key={id} className={`pr-cell${PLANS[id].monthlyPrice > 0 ? ' pr-col-featured' : ''}`} data-plan={PLANS[id].name}>
                <CellValue cell={row.value(PLANS[id])} />
              </span>
            ))}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
