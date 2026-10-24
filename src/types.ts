export type Step = 'upload' | 'edit' | 'copy' | 'history';

export type ToastType = 'success' | 'error';

export interface Tweet {
  style: string;
  tweet: string;
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
