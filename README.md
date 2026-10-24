# IdeaBird - Screenshot -> Content Generator

Upload a screenshot, extract text via OCR, then generate **5 high-signal social content formats** using **NVIDIA NIM**.

## Features

- **Screenshot upload**: drag/drop, click-to-browse, paste from clipboard
- **OCR extraction** with `tesseract.js` in the browser
- **Content generation** via an Express or Vercel API calling NVIDIA NIM chat completions
- **Moderation pre-check** blocks misinformation amplification before generation
- Generates a hot take tweet, question tweet, stat-lead tweet, thread, and LinkedIn version
- **Accounts**: email + password and Google sign-in; generating requires login
- **Private history**: every generation is saved to the user's account; nobody else can read or delete it

## Tech Stack

- **Client**: Vite + React + TypeScript, `tesseract.js`
- **Server**: Node.js ESM + Express in TypeScript (run with `tsx`), `dotenv`, NVIDIA NIM OpenAI-compatible HTTP API
- **Auth & data**: Postgres (Neon in production, embedded PGlite for local dev/tests), `jose` (JWT), Node `scrypt` password hashing, `zod` validation, `helmet`

## Project Structure

- `index.html`, `src/main.tsx`, `src/App.tsx`, `src/components/`, `src/style.css`: React frontend UI, OCR, results rendering
- `src/api.ts`: client for `POST /api/generate` with friendly error messages
- `src/auth/`: auth state, token handling (`client.ts`), login/signup modal, Google button
- `server/app.ts`: the Express app (security headers, routes); `server/index.ts` runs it locally, `api/index.ts` on Vercel
- `server/auth/`: signup/login/Google, JWT access tokens, rotating refresh tokens, password reset, email verification
- `server/history/routes.ts`, `server/generate/routes.ts`: per-user generation history and the generate endpoint
- `server/db/schema.sql`: database schema; `server/security/rateLimit.ts`: Postgres-backed rate limits
- `server/auth.test.ts`: integration tests for auth, token tampering, CSRF, rate limits and cross-user isolation
- `server/generateService.ts`: moderation check, NVIDIA NIM calls, model fallback chain
- `server/prompt.ts`: system prompt and user prompt builder for the model
- `server/tweetPipeline.ts`: parses the model output, scores quality, removes weak/duplicate content, and selects the required 5 formats

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment variables

Create a `.env` file in the project root:

```env
NVIDIA_API_KEY=your_key_here
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=meta/llama-3.3-70b-instruct
NVIDIA_FALLBACK_MODELS=nvidia/llama-3.3-nemotron-super-49b-v1
NVIDIA_TIMEOUT_MS=30000
NVIDIA_MODEL_ATTEMPTS=1
NVIDIA_MAX_TOKENS=1600
NVIDIA_MODERATION_MAX_TOKENS=8
PORT=3001
```

Notes:

- **`NVIDIA_API_KEY` is required**. The server also accepts the old `GEMINI_API_KEY` name as a temporary fallback.
- **`NVIDIA_BASE_URL`** defaults to `https://integrate.api.nvidia.com/v1`.
- **`NVIDIA_MODEL`** defaults to `meta/llama-3.3-70b-instruct`.
- **`NVIDIA_FALLBACK_MODELS`** is an optional comma-separated list tried when the primary model fails.
- **`NVIDIA_TIMEOUT_MS`** defaults to `30000`.
- **`NVIDIA_MODEL_ATTEMPTS`** defaults to `1`.
- **`NVIDIA_MAX_TOKENS`** defaults to `1600`.
- **`NVIDIA_MODERATION_MAX_TOKENS`** defaults to `8`.
- **`PORT`** defaults to `3001`.

Auth and database variables (see `.env.example` for details):

```env
# Local dev: embedded Postgres, no server needed. Production: your Neon pooled URL.
DATABASE_URL=pglite:./.data/ideabird
# At least 32 random characters:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
JWT_SECRET=
APP_URL=http://localhost:5173
GOOGLE_CLIENT_ID=        # optional; hides the Google button when empty
RESEND_API_KEY=          # optional locally; emails are printed to the API console instead
```

Security note: never commit real API keys. If a committed env example ever contains a real key, rotate it and replace it with a placeholder.

## Running Locally

### Development (client + server)

```bash
npm run dev
```

- Vite dev server runs on `http://localhost:5173`
- API runs on `http://localhost:3001`
- Vite proxies `/api/*` to `http://localhost:3001` through `vite.config.ts`
- With `DATABASE_URL=pglite:...` the schema is created automatically. Against real Postgres, run `npm run db:migrate` once (and after schema changes).
- Password-reset and verification emails are printed to the API console unless `RESEND_API_KEY` is set.

### Tests

```bash
npm test
```

Runs the API against an in-memory database: signup/login, lockout, token tampering, refresh-token rotation and reuse detection, CSRF checks, password reset, Google token verification, and cross-user data isolation.

### Run only the API

```bash
npm run dev:server
```

### Run only the client

```bash
npm run dev:client
```

## Production Build

```bash
npm run build
npm run preview
```

`build` type-checks the client (`tsconfig.app.json`) and server (`tsconfig.json`) before bundling. Run `npm run typecheck` on its own to check types only.

`preview` serves the built frontend with the same security headers (CSP etc.) as Vercel, read from `vercel.json`. Run `npm run dev:server` alongside it for the API.

## Vercel Deployment

`api/index.ts` serves the whole Express API as one Vercel function; `vercel.json` rewrites every `/api/*` request to it and adds the page's security headers.

Before the first deploy:

1. Create a Neon database (or Vercel Postgres, which is Neon) and copy the **pooled** connection string.
2. Run the migration against it once: `DATABASE_URL=<neon url> npm run db:migrate`.
3. For Google sign-in, create an OAuth client ID (type "Web application") in Google Cloud Console and add your production URL (and `http://localhost:5173`) to **Authorized JavaScript origins**.
4. For password-reset emails, create a Resend API key and verify your sending domain.

In Vercel, add these Environment Variables before redeploying:

```env
NVIDIA_API_KEY=your_key_here
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=openai/gpt-oss-20b
NVIDIA_TIMEOUT_MS=45000
NVIDIA_MODEL_ATTEMPTS=1
NVIDIA_MAX_TOKENS=4096
NVIDIA_MODERATION_MAX_TOKENS=2048
NVIDIA_TOTAL_TIMEOUT_MS=55000
DATABASE_URL=postgres://...neon.tech/neondb?sslmode=require
JWT_SECRET=<48 random bytes, base64>
APP_URL=https://your-app.vercel.app
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
RESEND_API_KEY=re_...
MAIL_FROM=IdeaBird <noreply@yourdomain.com>
```

`NVIDIA_API_KEY`, `DATABASE_URL`, `JWT_SECRET` and `APP_URL` are required. The rest have defaults.

The function's `maxDuration` is 60s (`api/index.ts`). `NVIDIA_TOTAL_TIMEOUT_MS` caps moderation plus every model attempt so the API returns a JSON 504 before Vercel kills the function; it is clamped to stay under `maxDuration`. Keep `NVIDIA_TIMEOUT_MS` below it, and keep `NVIDIA_MODEL_ATTEMPTS=1` on Vercel — retries of a ~35s reasoning call don't fit in 60s.

## Security

- **Passwords** are hashed with scrypt (memory-hard, per-user salt). Login always runs one hash check, so timing doesn't reveal which emails exist.
- **Access tokens** are short-lived (15 min) HS256 JWTs, kept only in memory on the client and sent as `Authorization: Bearer`. The algorithm, issuer and audience are pinned on verification.
- **Refresh tokens** are random, stored only as SHA-256 hashes, and sent as an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`. They rotate on every use; replaying an old one revokes the whole session family.
- **Revocation**: "Log out of all devices" and password resets bump a per-user token version, which invalidates every outstanding access token immediately.
- **Data isolation**: every history query is scoped to the authenticated user's id; another user's id returns the same 404 as an id that doesn't exist.
- **CSRF**: cookie-authenticated endpoints also require an `X-Requested-With` header and a same-origin `Origin`. There is no CORS policy, so other sites can't call the API from the browser.
- **Rate limits** (stored in Postgres, so they hold across serverless instances): signup, login, Google, password reset, and generation per user. 5 failed logins lock an email for 15 minutes, whether or not the account exists.
- **Email flows**: password reset (30 min, single use, revokes all sessions) and email verification (24 h). Tokens are hashed at rest, links are built from `APP_URL` (never the request's Host header), and the token is removed from the address bar immediately.
- **Google sign-in** verifies the ID token's signature, issuer, audience and `email_verified`. Linking Google to an existing *unverified* account drops that account's password and sessions, which blocks pre-registration account takeover.
- **Headers**: `helmet` on the API; CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy and Permissions-Policy on the site via `vercel.json`.
- **Input validation** with `zod`, parameterized SQL everywhere, 100 KB JSON body limit, and generic 500 responses that never leak internals.

Known trade-off: signup answers "an account with this email already exists", which reveals that the email is registered. It is rate limited; removing it would need email-first signup.

## API

Auth endpoints live under `/api/auth`: `signup`, `login`, `google`, `refresh`, `logout`, `logout-all`, `me`, `verify-email`, `resend-verification`, `forgot-password`, `reset-password`, and `config`. History: `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id`. All of them except the public auth ones require `Authorization: Bearer <access token>`.

### `POST /api/generate`

Requires `Authorization: Bearer <access token>`. Saves the result to the user's history and returns its `id`.

Body:

```json
{ "text": "string" }
```

Response:

```json
{
  "tweets": [
    { "style": "Hot Take Tweet", "tweet": "..." },
    { "style": "Question Tweet", "tweet": "..." },
    { "style": "Stat-Lead Tweet", "tweet": "..." },
    { "style": "Thread", "tweet": "1. ...\\n2. ..." },
    { "style": "LinkedIn Version", "tweet": "..." }
  ],
  "model": "nvidia/..."
}
```

Validation:

- Rejects empty text
- Rejects input longer than **10,000 characters**
- Runs a moderation classifier before generation
- Returns `status: "policy_block"` instead of generating amplified versions of unverified political allegations, conspiracy claims, or health misinformation
- Generates exactly **5 post-ready content formats**
- Scores each candidate for human-likeness, emotional impact, originality, punchiness, and platform-native style
- Returns objects with `style` and `tweet`

## Content Policy

We don't generate amplified versions of unverified political allegations or health misinformation. The deployed app includes this policy in `public/terms.html`.

## Troubleshooting

- **Server exits immediately**: ensure `NVIDIA_API_KEY` is set in `.env`.
- **401/403 invalid API key**: check that your key was copied from NVIDIA NIM and has not expired.
- **429 rate limited**: try again later or set `NVIDIA_MODEL` / `NVIDIA_FALLBACK_MODELS` to another available model.
- **503 overloaded**: NVIDIA NIM is temporarily overloaded; retry after a moment.
- **OCR returns empty**: try a higher-contrast screenshot or crop tighter around the text.
