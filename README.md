# IdeaBird - Screenshot -> Content Generator

Upload a screenshot, extract text via OCR, then generate **5 high-signal social content formats** using **NVIDIA NIM**.

## Features

- **Screenshot upload**: drag/drop, click-to-browse, paste from clipboard
- **OCR extraction** with `tesseract.js` in the browser
- **Content generation** via an Express or Vercel API calling NVIDIA NIM chat completions
- **Moderation pre-check** blocks misinformation amplification before generation
- Generates a hot take tweet, question tweet, stat-lead tweet, thread, and LinkedIn version

## Tech Stack

- **Client**: Vite + vanilla JS, `tesseract.js`
- **Server**: Node.js ESM + Express, `dotenv`, NVIDIA NIM OpenAI-compatible HTTP API

## Project Structure

- `index.html`, `main.js`, `style.css`: frontend UI, OCR, results rendering
- `server/index.js`: Express API (`POST /api/generate`)
- `server/prompt.js`: system prompt and user prompt builder for the model
- `server/tweetPipeline.js`: parses the model output, scores quality, removes weak/duplicate content, and selects the required 5 formats

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

Security note: never commit real API keys. If a committed env example ever contains a real key, rotate it and replace it with a placeholder.

## Running Locally

### Development (client + server)

```bash
npm run dev
```

- Vite dev server runs on `http://localhost:5173`
- API runs on `http://localhost:3001`
- Vite proxies `/api/*` to `http://localhost:3001` through `vite.config.js`

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

`preview` serves the built frontend only. For local generation, run `npm run dev` so the Express API runs too.

## Vercel Deployment

This project includes a serverless API route at `api/generate.js`, so the deployed frontend can call `/api/generate` on the same Vercel domain.

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
```

Only `NVIDIA_API_KEY` is required. The rest have defaults.

The function's `maxDuration` is 60s (`api/generate.js`). `NVIDIA_TOTAL_TIMEOUT_MS` caps moderation plus every model attempt so the API returns a JSON 504 before Vercel kills the function; it is clamped to stay under `maxDuration`. Keep `NVIDIA_TIMEOUT_MS` below it, and keep `NVIDIA_MODEL_ATTEMPTS=1` on Vercel — retries of a ~35s reasoning call don't fit in 60s.

## API

### `POST /api/generate`

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
