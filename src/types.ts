export type Step = 'upload' | 'insights' | 'copy' | 'history';

export type ToastType = 'success' | 'error';

export interface Tweet {
  style: string;
  tweet: string;
}

/** IdeaBird's understanding of a screenshot (mirrors server/vision/insight.ts). */
export interface ScreenshotInsight {
  summary: string;
  keyFacts: string[];
  metrics: { label: string; value: string; context?: string }[];
  notablePoints: string[];
  possibleStories: string[];
  contentAngles: string[];
  uncertainties: string[];
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
  error?: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
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
