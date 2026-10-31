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
    // SMTP (e.g. Gmail with an App Password). Used when RESEND_API_KEY isn't set.
    smtp: process.env.SMTP_USER && process.env.SMTP_PASS
      ? {
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: Number(process.env.SMTP_PORT || 465),
          user: process.env.SMTP_USER,
          // Google shows App Passwords with spaces; they aren't part of it.
          pass: process.env.SMTP_PASS.replace(/\s+/g, ''),
        }
      : null,
    mailFrom:
      process.env.MAIL_FROM ||
      (process.env.SMTP_USER && !process.env.RESEND_API_KEY ? `IdeaBird <${process.env.SMTP_USER}>` : 'IdeaBird <onboarding@resend.dev>'),
    generateLimitPerHour: Number(process.env.GENERATE_RATE_LIMIT_PER_HOUR || 30),
    // Dodo Payments. Billing is off until the API key and the monthly product are set.
    dodo: {
      apiKey: process.env.DODO_PAYMENTS_API_KEY || '',
      // Never live by accident: anything but "live_mode" is test mode.
      environment: process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? ('live_mode' as const) : ('test_mode' as const),
      // Either name works: Dodo's docs call it the webhook key, its dashboard the signing secret.
      webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY || process.env.DODO_PAYMENTS_WEBHOOK_SECRET || '',
      // Pro subscription products, one per billing period. Yearly is optional.
      products: {
        month: process.env.DODO_PRODUCT_ID || process.env.DODO_PRODUCT_ID_MONTHLY || '',
        year: process.env.DODO_PRODUCT_ID_YEARLY || '',
      },
    },
    // Write Like Me is hidden unless WRITE_LIKE_ME=on: no UI, no X calls, no voice in generation.
    writeLikeMe: (process.env.WRITE_LIKE_ME || '').toLowerCase() === 'on',
    // Write Like Me: X OAuth 2.0 app (read-only). Leave X_CLIENT_ID empty to hide the feature.
    // X_CLIENT_SECRET is set for a confidential ("Web App") client, empty for a public one.
    xClientId: process.env.X_CLIENT_ID || '',
    xClientSecret: process.env.X_CLIENT_SECRET || '',
  };
}

export function config() {
  cached ??= load();
  return cached;
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const RESET_TOKEN_TTL_MINUTES = 30;
// Email verification codes sent at sign-up.
export const OTP_TTL_MINUTES = 10;
export const MAX_OTP_ATTEMPTS = 5;
// Per-email lockout. Counted whether or not the account exists, so the lockout
// itself doesn't reveal which emails are registered.
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
