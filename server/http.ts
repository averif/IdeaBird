import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

/** An error whose message is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** Validates untrusted input; responds 400 with the first problem. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
  }
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.set(err.headers);
    return res.status(err.status).json({ error: err.message });
  }

  // express.json() parse failures and oversize bodies.
  const status = (err as { status?: number; type?: string }).status;
  if (status === 400 || status === 413) {
    return res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Invalid JSON request body.' });
  }

  // Never leak internals (SQL, stack traces) to the client.
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
