import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import { HttpError } from '../http.js';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let googleKeys: JWTVerifyGetKey | null = null;

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
}

/**
 * Verifies a Google Identity Services ID token: signature against Google's
 * published keys, issuer, audience (our client ID) and expiry. Only verified
 * Google emails are accepted.
 */
export async function verifyGoogleIdToken(
  credential: string,
  keys: JWTVerifyGetKey = (googleKeys ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')))
): Promise<GoogleProfile> {
  const clientId = config().googleClientId;
  if (!clientId) {
    throw new HttpError(503, 'Google sign-in is not configured on this server.');
  }

  try {
    const { payload } = await jwtVerify(credential, keys, {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    });

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) {
      throw new Error('Google account email is not verified.');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 120) : null,
    };
  } catch {
    throw new HttpError(401, 'Google sign-in failed. Please try again.');
  }
}
