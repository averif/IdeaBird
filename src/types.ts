export type Step = 'upload' | 'insights' | 'copy' | 'history';

export type ToastType = 'success' | 'error';

export interface Tweet {
  style: string;
  tweet: string;
}

/** Where a link-based insight came from (mirrors server/vision/insight.ts). */
export interface InsightSource {
  kind: 'youtube' | 'article' | 'x' | 'reddit';
  url: string;
  title: string;
  siteName?: string;
  author?: string;
  /** Set when the content was partial, e.g. a video without captions. */
  note?: string;
}

/** IdeaBird's understanding of a screenshot or link (mirrors server/vision/insight.ts). */
export interface ScreenshotInsight {
  summary: string;
  keyFacts: string[];
  metrics: { label: string; value: string; context?: string }[];
  notablePoints: string[];
  possibleStories: string[];
  contentAngles: string[];
  uncertainties: string[];
  /** Set for insights from a pasted link. */
  source?: InsightSource;
}

/** An insight plus the server's signature, required to generate posts from it. */
export interface Analysis {
  insight: ScreenshotInsight;
  insightToken: string;
}

export interface AnalyzeResponse extends Partial<Analysis> {
  status?: 'ok' | 'policy_block';
  needsOcr?: boolean;
  error?: string;
}

export interface GenerateResponse {
  status?: 'ok' | 'policy_block';
  id?: string;
  tweets?: Tweet[];
  model?: string;
  /** True when the posts were written in the user's Write Like Me voice. */
  voice?: boolean;
  usage?: Usage;
  error?: string;
}

export interface ThreadResponse {
  status?: 'ok';
  tweet?: Tweet;
  usage?: Usage;
  error?: string;
}

/** Generations used this month against the plan's allowance. */
export interface Usage {
  used: number;
  limit: number;
  resetsAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  plan: 'free' | 'pro';
}

export interface HistorySummary {
  id: string;
  createdAt: string;
  model: string | null;
  preview: string;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  model: string | null;
  sourceText: string;
  tweets: Tweet[];
}
