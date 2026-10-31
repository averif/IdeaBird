// IdeaBird schema. Idempotent: applied automatically on first database use (see
// ./index.ts) and by `npm run db:migrate`. Kept in a .ts module, not a .sql file,
// so serverless bundlers always ship it with the function.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,          -- always stored lowercased
  name                text,
  password_hash       text,                          -- null for Google-only accounts
  google_sub          text UNIQUE,
  email_verified      boolean NOT NULL DEFAULT false,
  -- Bumped to invalidate every access token at once (logout everywhere, password reset).
  token_version       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens are opaque random strings; only their SHA-256 hash is stored.
-- Rotation: each refresh revokes the presented token and issues a new one in the
-- same family. Presenting an already-rotated token revokes the whole family.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Single-use tokens sent by email (verification, password reset). Hash only.
CREATE TABLE IF NOT EXISTS email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose);

CREATE TABLE IF NOT EXISTS generations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_text  text NOT NULL,
  tweets       jsonb NOT NULL,
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generations_user_created_idx ON generations (user_id, created_at DESC);

-- Fixed-window counters shared across serverless instances: request rate limits
-- and failed-login lockouts.
CREATE TABLE IF NOT EXISTS rate_limits (
  key       text PRIMARY KEY,
  count     integer NOT NULL,
  reset_at  timestamptz NOT NULL
);

-- Write Like Me. Pending X OAuth requests: single use, short-lived. Only the hash
-- of the state and of the browser-binding nonce are stored.
CREATE TABLE IF NOT EXISTS x_oauth_states (
  state_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce_hash     text NOT NULL,
  code_verifier  text NOT NULL,
  expires_at     timestamptz NOT NULL
);

-- A user's X connection. Tokens are AES-GCM encrypted and never leave the server.
CREATE TABLE IF NOT EXISTS x_connections (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  x_user_id          text NOT NULL,
  username           text NOT NULL,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text,
  expires_at         timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- How a user writes, learned once from their posts. The posts themselves are
-- never stored: only this style profile and a few measured stats.
CREATE TABLE IF NOT EXISTS voice_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile     jsonb NOT NULL,
  post_count  integer NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
`;
