export type Step = 'upload' | 'edit' | 'copy';

export type ToastType = 'success' | 'error';

export interface Tweet {
  style: string;
  tweet: string;
}

export interface GenerateResponse {
  status?: 'ok' | 'policy_block';
  tweets?: Tweet[];
  model?: string;
  error?: string;
}
