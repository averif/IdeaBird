import { apiFetch } from './auth/client';
import type { GenerateResponse } from './types';

function isLocalHost(): boolean {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

async function readApiJson(res: Response): Promise<GenerateResponse> {
  const body = await res.text();
  if (!body) return {};

  try {
    return JSON.parse(body) as GenerateResponse;
  } catch {
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 120);

    // Hosts answer a function that ran past its time limit with their own non-JSON page
    // (Vercel: 504 FUNCTION_INVOCATION_TIMEOUT), not with our JSON error.
    if (res.status === 504 || /timeout|timed out/i.test(preview)) {
      throw new Error('IdeaBird took too long to generate and the request timed out. Try again, or use a shorter excerpt.');
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

/** Thrown when the user must (re)authenticate before generating. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Log in to generate posts.');
  }
}

export async function postGenerateRequest(text: string): Promise<{ res: Response; data: GenerateResponse }> {
  let res: Response;
  try {
    res = await apiFetch('/api/generate', { method: 'POST', body: JSON.stringify({ text }) });
  } catch {
    throw new Error(
      isLocalHost()
        ? 'IdeaBird backend is not running. Start the full app with npm run dev, then try Generate again.'
        : 'IdeaBird API is not reachable. Check the Vercel deployment and environment variables.'
    );
  }

  if (res.status === 401) throw new AuthRequiredError();
  return { res, data: await readApiJson(res) };
}
