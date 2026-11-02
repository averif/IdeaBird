// IdeaBird plans: the single place to change prices, limits and plan copy.
// Shared by the client (pricing page) and, once billing ships, the server
// (limit checks and Dodo Payments checkout), so both always agree.

export type PlanId = 'free' | 'pro';
export type BillingInterval = 'month' | 'year';

export interface PlanLimits {
  /** AI generations allowed per calendar month. */
  generationsPerMonth: number;
  /** Drafts returned per generation (Pro gets every format IdeaBird writes). */
  draftsPerGeneration: number;
  /** Generations and drafts are saved to History. */
  history: boolean;
  /** Custom tone and standing writing instructions. */
  customVoice: boolean;
  /** Turn a single post into a full X thread. */
  threadExpansion: boolean;
  /** Paste a post and get it back polished (Refine page). */
  refine: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Price per month on monthly billing, in currency units. 0 = free. */
  monthlyPrice: number;
  /** Price per year on yearly billing, charged once a year. */
  yearlyPrice: number;
  limits: PlanLimits;
}
// The Dodo Payments products behind Pro live in the server's environment
// (DODO_PRODUCT_ID, DODO_PRODUCT_ID_YEARLY), not here: the browser never picks one.

export const BILLING = {
  currency: 'USD',
  /** Billing period selected when the pricing page opens. */
  defaultInterval: 'month' as BillingInterval,
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Try IdeaBird on your best screenshots.',
    monthlyPrice: 0,
    yearlyPrice: 0,
    limits: {
      generationsPerMonth: 10,
      draftsPerGeneration: 1,
      history: false,
      customVoice: false,
      threadExpansion: false,
      refine: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For people who post every week.',
    // Must match the Dodo products (DODO_PRODUCT_ID, DODO_PRODUCT_ID_YEARLY):
    // Dodo charges the product's price, this only displays it.
    monthlyPrice: 4.99,
    // Two months free compared with paying monthly.
    yearlyPrice: 49.7,
    limits: {
      generationsPerMonth: 500,
      draftsPerGeneration: 5,
      history: true,
      customVoice: true,
      threadExpansion: true,
      refine: true,
    },
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'pro'];

export interface LaunchOffer {
  /** Dodo discount code, applied automatically at checkout. */
  code: string;
  percentOff: number;
  /** Billing cycles the discount lasts; full price after. */
  cycles: number;
  /** The only billing period it applies to (the Dodo discount is restricted to that product). */
  interval: BillingInterval;
  /** When the code expires in Dodo. The offer disappears after this. */
  endsAt: string;
}

/**
 * The launch discount. Must match the discount set up in Dodo (LAUNCH50: 50%,
 * 2 cycles, monthly Pro only, expires 2 Jan 2027). Set to null to switch it off.
 */
export const LAUNCH_OFFER: LaunchOffer | null = {
  code: 'LAUNCH50',
  percentOff: 50,
  cycles: 2,
  interval: 'month',
  endsAt: '2027-01-02T23:59:59.999Z',
};

/** The launch offer if it applies to this billing period right now, else null. */
export function activeOffer(interval: BillingInterval, now: Date = new Date()): LaunchOffer | null {
  if (!LAUNCH_OFFER || LAUNCH_OFFER.interval !== interval) return null;
  return now.getTime() <= Date.parse(LAUNCH_OFFER.endsAt) ? LAUNCH_OFFER : null;
}

/** The discounted price for the offer's cycles, rounded to cents. */
export function offerPrice(plan: Plan, offer: LaunchOffer): number {
  return Math.round(plan.monthlyPrice * (100 - offer.percentOff)) / 100;
}

/**
 * Features announced on the pricing page but not built yet. They're labelled
 * "Coming soon" so nobody pays for something that doesn't exist. Remove a key
 * here when the feature ships.
 */
export const COMING_SOON: Partial<Record<keyof PlanLimits, true>> = {};

/** What the plan costs per month on this billing period (yearly is spread over 12). */
export function pricePerMonth(plan: Plan, interval: BillingInterval): number {
  return interval === 'year' ? plan.yearlyPrice / 12 : plan.monthlyPrice;
}

/** Whole-percent saving of yearly over 12 monthly payments, e.g. 17. 0 if none. */
export function yearlySavingsPercent(plan: Plan): number {
  const fullYear = plan.monthlyPrice * 12;
  return fullYear > 0 ? Math.max(0, Math.round((1 - plan.yearlyPrice / fullYear) * 100)) : 0;
}

/** "$9", "$7.50", "$0". */
export function formatPrice(amount: number, currency = BILLING.currency): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
}
