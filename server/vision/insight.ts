import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** IdeaBird's understanding of a screenshot: what it means, not every word on it. */
export interface ScreenshotInsight {
  summary: string;
  keyFacts: string[];
  metrics: { label: string; value: string; context?: string }[];
  notablePoints: string[];
  possibleStories: string[];
  contentAngles: string[];
  /** Important things the vision model couldn't read reliably. */
  uncertainties: string[];
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clip(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

/**
 * Coerces untrusted input (model output or a client request) into a well-formed,
 * size-bounded insight. Idempotent, so it doubles as the canonical form we sign.
 */
export function normalizeInsight(raw: unknown): ScreenshotInsight {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const metrics = Array.isArray(input.metrics) ? input.metrics : [];

  return {
    summary: clip(input.summary, 700),
    keyFacts: strings(input.keyFacts, 12, 300),
    metrics: metrics
      .map((metric) => {
        const m = (metric && typeof metric === 'object' ? metric : {}) as Record<string, unknown>;
        const context = clip(m.context, 200);
        return { label: clip(m.label, 80), value: clip(m.value, 60), ...(context ? { context } : {}) };
      })
      .filter((m) => m.label && m.value)
      .slice(0, 20),
    notablePoints: strings(input.notablePoints, 10, 300),
    possibleStories: strings(input.possibleStories, 8, 200),
    contentAngles: strings(input.contentAngles, 8, 200),
    uncertainties: strings(input.uncertainties, 8, 200),
  };
}

export function isEmptyInsight(insight: ScreenshotInsight): boolean {
  return !insight.summary && insight.keyFacts.length === 0 && insight.metrics.length === 0;
}

/** Plain-text digest: stored as the history "source" and used to score posts for concreteness. */
export function insightToText(insight: ScreenshotInsight): string {
  return [
    insight.summary,
    ...insight.keyFacts,
    ...insight.metrics.map((m) => `${m.label}: ${m.value}${m.context ? ` (${m.context})` : ''}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the writer model receives: structured understanding, never raw OCR. */
export function insightBrief(insight: ScreenshotInsight, focusAngle?: string | null): string {
  const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '');
  return [
    `Summary: ${insight.summary}`,
    list('Key facts', insight.keyFacts),
    list('Metrics (exact values from the screenshot)', insight.metrics.map((m) => `${m.label}: ${m.value}${m.context ? ` (${m.context})` : ''}`)),
    list('Notable points', insight.notablePoints),
    list('Possible stories', insight.possibleStories),
    list('Content angles', insight.contentAngles),
    list('Unclear in the screenshot (never state these as fact)', insight.uncertainties),
    focusAngle ? `FOCUS ANGLE: build every post around this angle: ${focusAngle}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// --- Signing -------------------------------------------------------------------
// The server analyzes (and moderates) the screenshot, then hands the insight to
// the browser, which sends it back when generating. Signing it means the client
// can't swap in different content or skip moderation, without storing anything.

const TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function signature(userId: string, issuedAt: number, insight: ScreenshotInsight): Buffer {
  const key = createHmac('sha256', config().jwtSecret).update('ideabird:insight:v1').digest();
  return createHmac('sha256', key).update(`${userId}.${issuedAt}.${JSON.stringify(normalizeInsight(insight))}`).digest();
}

export function signInsight(userId: string, insight: ScreenshotInsight): string {
  const issuedAt = Date.now();
  return `${issuedAt}.${signature(userId, issuedAt, insight).toString('base64url')}`;
}

export function verifyInsight(userId: string, insight: ScreenshotInsight, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const [issued, sig] = token.split('.');
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || !sig || Date.now() - issuedAt > TOKEN_MAX_AGE_MS || issuedAt > Date.now() + 60_000) return false;

  const expected = signature(userId, issuedAt, insight);
  const actual = Buffer.from(sig, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
