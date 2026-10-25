// Central, validated server configuration. Read lazily so tests can set env vars
// before the first access, and so a missing secret fails loudly instead of silently
// signing tokens with an empty key.

const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

export class ConfigError extends Error {}

let cached: ReturnType<typeof load> | null = null;

function load() {
  // Collect every problem at once, so a deploy can be fixed in one go.
  const problems: string[] = [];
  const missing = ['DATABASE_URL', 'JWT_SECRET', ...(isProduction ? ['APP_URL'] : [])].filter((name) => !process.env[name]);
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);

  const jwtSecret = process.env.JWT_SECRET || '';
  if (jwtSecret && jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters (generate one with: openssl rand -base64 48)');
  }

  // Email links must never be built from the request's Host header (host-header injection).
  const appUrl = (process.env.APP_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
  let appOrigin = '';
  if (appUrl) {
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      problems.push(`APP_URL must be a full URL including https://, e.g. https://ideabird.example.com`);
    }
  }

  if (problems.length) {
    throw new ConfigError(`Server environment variables need attention: ${problems.join('; ')}. See .env.example.`);
  }

  return {
    isProduction,
    onVercel: Boolean(process.env.VERCEL),
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: new TextEncoder().encode(jwtSecret),
    appUrl,
    appOrigin,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    mailFrom: process.env.MAIL_FROM || 'IdeaBird <onboarding@resend.dev>',
    generateLimitPerHour: Number(process.env.GENERATE_RATE_LIMIT_PER_HOUR || 30),
  };
}

export function config() {
  cached ??= load();
  return cached;
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const RESET_TOKEN_TTL_MINUTES = 30;
export const VERIFY_TOKEN_TTL_HOURS = 24;
// Per-email lockout. Counted whether or not the account exists, so the lockout
// itself doesn't reveal which emails are registered.
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
