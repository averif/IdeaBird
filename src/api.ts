import { apiFetch } from './auth/client';
import type { Analysis, AnalyzeResponse, GenerateResponse, ThreadResponse } from './types';

function isLocalHost(): boolean {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

async function readApiJson<T extends { error?: string }>(res: Response): Promise<T> {
  const body = await res.text();
  if (!body) return {} as T;

  try {
    return JSON.parse(body) as T;
  } catch {
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 120);

    // Hosts answer a function that ran past its time limit with their own non-JSON page
    // (Vercel: 504 FUNCTION_INVOCATION_TIMEOUT), not with our JSON error.
    if (res.status === 504 || /timeout|timed out/i.test(preview)) {
      throw new Error('IdeaBird took too long and the request timed out. Please try again.');
    }

    if (res.status === 413) {
      throw new Error('That screenshot is too large. Try cropping it.');
    }

    if (res.status === 404 || preview.toLowerCase().includes('page could not be found')) {
      throw new Error('IdeaBird API was not found. Run the full app with npm run dev so the backend starts too.');
    }

    if (preview.toLowerCase().includes('connect') || preview.toLowerCase().includes('econnrefused')) {
      throw new Error('IdeaBird backend is not running. Start it with npm run dev:server or use npm run dev.');
    }

    throw new Error(
      isLocalHost()
        ? 'IdeaBird received an invalid API response. Make sure the backend is running on http://localhost:3001.'
        : `IdeaBird received an invalid API response (HTTP ${res.status}). Check the Vercel function logs.`
    );
  }
}

/** An API error with the server's machine-readable code, e.g. 'limit_reached'. */
export class ApiCodeError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

/** Thrown when the user must (re)authenticate first. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Log in to continue.');
  }
}

async function postJson<T extends { error?: string }>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    throw new Error(
      isLocalHost()
        ? 'IdeaBird backend is not running. Start the full app with npm run dev, then try again.'
        : 'IdeaBird API is not reachable. Check the Vercel deployment and environment variables.'
    );
  }

  if (res.status === 401) throw new AuthRequiredError();
  const data = await readApiJson<T & { code?: string }>(res);
  if (!res.ok) throw new ApiCodeError(data.error || 'Something went wrong. Please try again.', data.code);
  return data;
}

/** Vision step: the server's vision model reads the screenshot. */
export function analyzeScreenshot(image: string) {
  return postJson<AnalyzeResponse>('/api/analyze', { image });
}

/** Fallback step: merge OCR text into the analysis as supporting evidence. */
export function refineWithOcr(analysis: Analysis, ocrText: string) {
  return postJson<AnalyzeResponse>('/api/analyze/refine', { ...analysis, ocrText });
}

export function generatePosts(analysis: Analysis, angle: string | null) {
  return postJson<GenerateResponse>('/api/generate', { ...analysis, angle });
}

/** Pro: expand one post into a full X thread, grounded in the same analysis. */
export function expandThread(analysis: Analysis, post: string, generationId: string | null) {
  return postJson<ThreadResponse>('/api/generate/thread', { ...analysis, post, generationId });
}
