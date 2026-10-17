import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { assertApiKey, generateTweetsWithFallback, NIM_CONFIG } from './generateService.js';

const app = express();
const PORT = process.env.PORT || 3001;
const GENERATION_BUDGET_MS = Number(process.env.NVIDIA_TOTAL_TIMEOUT_MS) || undefined;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

try {
  assertApiKey();
} catch {
  console.error('\x1b[31mX NVIDIA_API_KEY is missing. Copy .env.example to .env and add your NVIDIA NIM key.\x1b[0m');
  process.exit(1);
}

app.post('/api/generate', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided. Extract text from a screenshot first.' });
  }

  if (text.length > 10000) {
    return res.status(400).json({ error: 'Text is too long. Please use a shorter excerpt (max 10,000 characters).' });
  }

  try {
    const result = await generateTweetsWithFallback(text.trim(), { budgetMs: GENERATION_BUDGET_MS });
    if (result.status === 'policy_block') {
      return res.json({
        status: 'policy_block',
        tweets: [],
        error:
          'IdeaBird does not generate amplified versions of unverified political allegations, conspiracy claims, or health misinformation.',
      });
    }

    return res.json({ status: 'ok', tweets: result.tweets, model: result.model });
  } catch (err) {
    return sendGenerateError(res, err);
  }
});

function sendGenerateError(res, err) {
  console.error('Generate error:', err.message || err);

  const status = err.status || err.httpCode;
  if (status === 401 || status === 403) {
    return res.status(401).json({ error: 'Invalid or missing NVIDIA API key. Add NVIDIA_API_KEY in your environment variables.' });
  }
  if (status === 429) {
    return res.status(429).json({
      error: 'NVIDIA NIM rate limit or quota was reached. Try again later or set NVIDIA_MODEL / NVIDIA_FALLBACK_MODELS to another available model.',
    });
  }
  if (status === 503) {
    return res.status(503).json({ error: 'NVIDIA NIM is currently overloaded. Try again in a few seconds.' });
  }

  return res.status(status || 500).json({
    error: err.message || 'Something went wrong generating tweets. Please try again.',
  });
}

app.listen(PORT, () => {
  console.log(`\x1b[32mIdeaBird API running on http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[36m  NVIDIA NIM endpoint: ${NIM_CONFIG.baseUrl}\x1b[0m`);
  console.log(`\x1b[36m  Models: ${NIM_CONFIG.modelCandidates.join(' -> ')} (fallback chain)\x1b[0m`);
});
