import { PLANS, type PlanId } from '../../shared/plans.js';
import { query } from '../db/index.js';

// Monthly generation allowance per plan (shared/plans.ts). Months are calendar
// months in UTC: the count resets on the 1st.

export interface Usage {
  used: number;
  limit: number;
  /** First moment of next month (UTC), when the allowance resets. */
  resetsAt: string;
}

function nextMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export async function usageFor(userId: string, plan: PlanId): Promise<Usage> {
  const [row] = await query<{ generations: number }>(
    `SELECT generations FROM usage_monthly WHERE user_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [userId]
  );
  return { used: row?.generations ?? 0, limit: PLANS[plan].limits.generationsPerMonth, resetsAt: nextMonthStart() };
}

/**
 * Claims one generation from this month's allowance, atomically: concurrent
 * requests can't push a user past the limit. Returns the new count, or null when
 * the allowance is used up. Give it back with releaseGeneration if the
 * generation then fails, so users only pay for posts they actually got.
 */
export async function reserveGeneration(userId: string, plan: PlanId): Promise<number | null> {
  const limit = PLANS[plan].limits.generationsPerMonth;
  if (limit <= 0) return null;
  const [row] = await query<{ generations: number }>(
    `INSERT INTO usage_monthly (user_id, month, generations)
     VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (user_id, month) DO UPDATE SET generations = usage_monthly.generations + 1
       WHERE usage_monthly.generations < $2
     RETURNING generations`,
    [userId, limit]
  );
  return row?.generations ?? null;
}

export async function releaseGeneration(userId: string): Promise<void> {
  await query(
    `UPDATE usage_monthly SET generations = generations - 1
      WHERE user_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND generations > 0`,
    [userId]
  );
}

// Free's separate refine allowance (PLANS.free.limits.refinesPerMonth). Pro has
// none: its refines use generations, through the functions above.

export async function refineUsageFor(userId: string, plan: PlanId): Promise<Usage | null> {
  const limit = PLANS[plan].limits.refinesPerMonth;
  if (limit === null) return null;
  const [row] = await query<{ refines: number }>(
    `SELECT refines FROM usage_monthly WHERE user_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [userId]
  );
  return { used: row?.refines ?? 0, limit, resetsAt: nextMonthStart() };
}

/** Claims one refine, atomically like reserveGeneration. Null when used up. */
export async function reserveRefine(userId: string, limit: number): Promise<number | null> {
  if (limit <= 0) return null;
  const [row] = await query<{ refines: number }>(
    `INSERT INTO usage_monthly (user_id, month, refines)
     VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (user_id, month) DO UPDATE SET refines = usage_monthly.refines + 1
       WHERE usage_monthly.refines < $2
     RETURNING refines`,
    [userId, limit]
  );
  return row?.refines ?? null;
}

export async function releaseRefine(userId: string): Promise<void> {
  await query(
    `UPDATE usage_monthly SET refines = refines - 1
      WHERE user_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND refines > 0`,
    [userId]
  );
}
