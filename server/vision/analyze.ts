import {
  createError,
  deadlineFrom,
  MODEL_CANDIDATES,
  modelList,
  requestChatCompletion,
  withModelFallback,
} from '../generateService.js';
import { normalizeInsight, isEmptyInsight, type ScreenshotInsight } from './insight.js';

// Vision models that can read the screenshot directly. Both were verified to read
// a test dashboard correctly with the current key (Nemotron VL in ~3s).
export const VISION_MODELS = modelList(
  process.env.NVIDIA_VISION_MODEL,
  process.env.NVIDIA_VISION_FALLBACK_MODELS ?? 'meta/llama-3.2-11b-vision-instruct',
  'nvidia/nemotron-3.5-super-vl-120b-a12b'
);
// Covers hidden reasoning (~300 tokens) plus the JSON answer.
const VISION_MAX_TOKENS = Number(process.env.NVIDIA_VISION_MAX_TOKENS || 3000);

const ANALYSIS_PROMPT = `You are IdeaBird's screenshot analyst. Look at this screenshot and work out what it MEANS and what is worth turning into social content.

Read it the way a sharp human would: visible text, numbers, metrics, charts and graphs, UI and product interfaces, dashboards, websites, layout, visual context, relationships between pieces of information, and important changes or patterns.

Do NOT transcribe every word. Extract what matters.

Return ONLY a JSON object (no markdown, no code fences) with these keys:
{
  "summary": "1-3 sentences: what the screenshot shows and why it matters",
  "keyFacts": ["specific, important facts, with exact names/dates/numbers as shown"],
  "metrics": [{"label": "Revenue", "value": "$12,430", "context": "October, up from last month"}],
  "notablePoints": ["patterns, changes, comparisons, surprising details"],
  "possibleStories": ["stories someone could tell from this, e.g. 'Revenue milestone'"],
  "contentAngles": ["specific angles for posts, e.g. 'What caused the 42% growth'"],
  "uncertainties": ["ONLY important information you cannot read reliably (tiny, blurry, cut off). Empty if everything important is clear."],
  "readability": "clear" | "partial" | "poor",
  "misinformationRisk": true | false
}

Rules:
- Copy numbers, percentages, dates, product names, usernames, URLs and code exactly as shown. Never guess a value: if you can't read it, put it in "uncertainties" instead.
- "metrics" only for real values visible in the screenshot. Use [] if there are none.
- "readability" is "clear" if you could read everything important.
- "misinformationRisk" is true only if the screenshot presents unverified allegations as fact, conspiracy claims, or health misinformation.`;

const REFINE_PROMPT = `You are given IdeaBird's understanding of a screenshot (produced by looking at the image) and OCR text recognized from the same screenshot.

The visual understanding is the primary source. Use the OCR text ONLY as supporting evidence to:
- fill in or correct exact values listed under "uncertainties" (numbers, names, dates, URLs, code, error messages),
- fix exact wording of names and numbers already present.
Do not change the overall interpretation, stories or angles because of OCR. OCR text may contain recognition errors; ignore anything that doesn't fit what the screenshot shows.

Return ONLY the updated JSON object with the same keys: summary, keyFacts, metrics, notablePoints, possibleStories, contentAngles, uncertainties (keep only items still unresolved).`;

export interface ScreenshotAnalysis {
  insight: ScreenshotInsight;
  /** True when supplemental OCR could recover information vision couldn't read. */
  needsOcr: boolean;
  blocked: boolean;
  model: string;
}

export async function analyzeScreenshot(imageDataUrl: string, { budgetMs }: { budgetMs?: number } = {}): Promise<ScreenshotAnalysis> {
  const deadline = deadlineFrom(budgetMs);

  const { value, model } = await withModelFallback(VISION_MODELS, 'Vision', async (modelName) => {
    const raw = await requestChatCompletion({
      modelName,
      deadline,
      // Instructions go in the user turn: some vision endpoints reject a system
      // message alongside an image.
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: ANALYSIS_PROMPT },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      maxTokens: VISION_MAX_TOKENS,
    });

    const parsed = parseJsonObject(raw);
    const insight = normalizeInsight(parsed);
    if (isEmptyInsight(insight)) {
      throw createError('The vision model returned no usable analysis.', { retryable: true });
    }
    return { parsed, insight };
  });

  const readability = String(value.parsed.readability || 'clear').toLowerCase();
  return {
    insight: value.insight,
    needsOcr: value.insight.uncertainties.length > 0 || readability !== 'clear',
    blocked: value.parsed.misinformationRisk === true,
    model,
  };
}

/**
 * Merges supplemental OCR text into the visual understanding. Vision stays the
 * primary source: if this step fails, the original insight is kept.
 */
export async function refineWithOcr(
  insight: ScreenshotInsight,
  ocrText: string,
  { budgetMs }: { budgetMs?: number } = {}
): Promise<ScreenshotInsight> {
  const deadline = deadlineFrom(budgetMs);
  try {
    const { value } = await withModelFallback(MODEL_CANDIDATES, 'OCR merge', async (modelName) => {
      const raw = await requestChatCompletion({
        modelName,
        deadline,
        thinking: false,
        messages: [
          { role: 'system', content: REFINE_PROMPT },
          {
            role: 'user',
            content: `VISUAL UNDERSTANDING:\n${JSON.stringify(insight)}\n\nOCR TEXT (supporting evidence only):\n---\n${ocrText}\n---`,
          },
        ],
        temperature: 0.1,
        maxTokens: VISION_MAX_TOKENS,
      });
      const refined = normalizeInsight(parseJsonObject(raw));
      if (isEmptyInsight(refined)) throw createError('OCR merge returned no usable analysis.', { retryable: true });
      return refined;
    });
    return value;
  } catch (err) {
    console.error(`[IdeaBird] OCR merge failed (${(err as Error).message?.slice(0, 120)}); keeping the visual analysis.`);
    return insight;
  }
}

/** Extracts the first top-level JSON object from model output (tolerates prose and code fences). */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(start, index + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch {
            // fall through to the error below
          }
          break;
        }
      }
    }
  }
  throw createError('Could not parse the screenshot analysis (invalid JSON).', { retryable: true });
}
