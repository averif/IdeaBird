// Central, validated server configuration. Read lazily so tests can set env vars
// before the first access, and so a missing secret fails loudly instead of silently
// signing tokens with an empty key.

const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is missing. Add it to your environment variables (see .env.example).`);
  }
  return value;
}

let cached: ReturnType<typeof load> | null = null;

function load() {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48');
  }

  const appUrl = (process.env.APP_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
  if (!appUrl) {
    // Email links must never be built from the request's Host header (host-header injection).
    throw new Error('APP_URL is missing. Set it to the public URL of the app, e.g. https://ideabird.vercel.app');
  }

  return {
    isProduction,
    onVercel: Boolean(process.env.VERCEL),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: new TextEncoder().encode(jwtSecret),
    appUrl,
    appOrigin: new URL(appUrl).origin,
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
