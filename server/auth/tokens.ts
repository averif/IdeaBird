import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS, config } from '../config.js';

const ISSUER = 'ideabird';
const AUDIENCE = 'ideabird-api';

export interface AccessClaims {
  sub: string;
  /** Must match users.token_version, so bumping it revokes outstanding tokens. */
  ver: number;
}

export function signAccessToken({ sub, ver }: AccessClaims): Promise<string> {
  return new SignJWT({ ver })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(config().jwtSecret);
}

/** Returns the claims, or null for any invalid, expired, or tampered token. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config().jwtSecret, {
      // Pin the algorithm: rejects `alg: none` and algorithm-confusion tricks.
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.ver !== 'number') return null;
    return { sub: payload.sub, ver: payload.ver };
  } catch {
    return null;
  }
}

/** 256-bit URL-safe random token for refresh cookies and email links. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored hashed, so a database leak doesn't hand out live sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
