import { HttpError } from '../http.js';

// The browser downsizes screenshots before upload; this is the hard server limit.
// It stays under Vercel's 4.5 MB request body cap once base64-encoded.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Accepts only a base64 data URL for a PNG, JPEG or WebP whose bytes really are
 * that format (the declared type alone is attacker-controlled). Returns a clean
 * data URL rebuilt from the decoded bytes.
 */
export function validateImageDataUrl(value: unknown): string {
  const match = typeof value === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value) : null;
  if (!match) {
    throw new HttpError(400, 'Upload a PNG, JPG or WebP screenshot.');
  }

  const [, format, base64] = match;
  if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES + 3) {
    throw new HttpError(413, 'That screenshot is too large. Try a smaller one.');
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !SIGNATURES[format](bytes)) {
    throw new HttpError(400, "That file doesn't look like a valid image.");
  }

  return `data:image/${format};base64,${bytes.toString('base64')}`;
}
