import { deadlineFrom, MODEL_CANDIDATES, requestChatCompletion, withModelFallback } from '../generateService.js';
import type { XPost } from './xClient.js';

// A Voice Profile describes HOW someone writes, never WHAT they wrote. It is built
// once from their recent posts (which are then discarded) and is the only thing
// the post writer sees.

export const MIN_POSTS = 10;

export const TRAIT_KEYS = ['tone', 'sentenceStyle', 'vocabulary', 'hooks', 'structure', 'punctuation', 'emoji', 'humor'] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

/** Measured from the posts, so these traits are grounded by construction. */
export interface VoiceStats {
  postCount: number;
  medianChars: number;
  wordsPerSentence: number;
  /** Shares of posts, 0..1. */
  lowercaseStart: number;
  multiLine: number;
  lists: number;
  questions: number;
  exclamations: number;
  emoji: number;
  hashtags: number;
  links: number;
}

export interface VoiceProfile {
  /** One or two sentences shown to the user ("You write..."). */
  summary: string;
  traits: Record<TraitKey, string[]>;
  avoid: string[];
  stats: VoiceStats;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const share = (posts: string[], test: (text: string) => boolean) => (posts.length ? posts.filter(test).length / posts.length : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Removes links and @mentions: they're content (who/where), not style. */
function clean(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '').replace(/(^|\s)@\w+/g, '$1').replace(/[ \t]+/g, ' ').trim();
}

export function computeStats(posts: XPost[]): VoiceStats {
  const texts = posts.map((p) => p.text);
  const lengths = texts.map((t) => clean(t).length).sort((a, b) => a - b);
  const sentences = texts.flatMap((t) => clean(t).split(/(?<=[.!?])\s+|\n+/).filter((s) => /\w/.test(s)));
  const words = sentences.reduce((sum, s) => sum + s.split(/\s+/).filter(Boolean).length, 0);

  return {
    postCount: texts.length,
    medianChars: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
    wordsPerSentence: sentences.length ? Math.round((words / sentences.length) * 10) / 10 : 0,
    lowercaseStart: round2(share(texts, (t) => /^[a-z]/.test(clean(t)))),
    multiLine: round2(share(texts, (t) => /\n/.test(t))),
    lists: round2(share(texts, (t) => (t.match(/^\s*(?:[-•*→]|\d+[.)])\s+/gm) ?? []).length >= 2)),
    questions: round2(share(texts, (t) => /\?/.test(t))),
    exclamations: round2(share(texts, (t) => /!/.test(t))),
    emoji: round2(share(texts, (t) => EMOJI.test(t))),
    hashtags: round2(share(texts, (t) => /(^|\s)#\w/.test(t))),
    links: round2(share(texts, (t) => /https?:\/\//.test(t))),
  };
}

const ANALYSIS_PROMPT = `You study how one person writes on X so a writer can match their STYLE on new topics.

You get their recent original posts and some measured stats. Describe their writing style.

Return ONLY a JSON object (no markdown, no code fences):
{
  "summary": "1-2 sentences, second person, e.g. 'You write short, lowercase, matter-of-fact posts that open with a blunt claim.'",
  "tone": [], "sentenceStyle": [], "vocabulary": [], "hooks": [], "structure": [], "punctuation": [], "emoji": [], "humor": [],
  "avoid": ["things this person clearly never does, e.g. 'hashtags', 'exclamation marks', 'corporate buzzwords'"]
}
Each list holds 0-4 short trait descriptions (under 15 words each).

Rules:
- Only include a trait if it shows up across SEVERAL posts. If the posts don't support a trait, leave that list empty.
- Describe patterns, not content. Never quote or paraphrase a post, never include a distinctive phrase, and never mention their topics, products, companies, people, numbers or opinions.
- Good: "opens with a one-line contrarian claim", "drops the subject in casual sentences". Bad: anything copied from a post.
- "hooks": how posts open. "structure": length, line breaks, lists, threads. "vocabulary": register and word choice (plain, technical, slangy), not specific words they use.
- Stay consistent with the measured stats.`;

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Every run of `n` consecutive words in the posts. */
function ngramSet(posts: XPost[], n: number): Set<string> {
  const set = new Set<string>();
  for (const post of posts) {
    const w = wordsOf(clean(post.text));
    for (let i = 0; i + n <= w.length; i += 1) set.add(w.slice(i, i + n).join(' '));
  }
  return set;
}

/** True when `text` reuses 4+ consecutive words from any post, i.e. copies their content. */
export function copiesPosts(text: string, postGrams: Set<string>, n = 4): boolean {
  const w = wordsOf(text);
  for (let i = 0; i + n <= w.length; i += 1) if (postGrams.has(w.slice(i, i + n).join(' '))) return true;
  return false;
}

/**
 * Coerces model output into a bounded profile and strips anything copied from
 * the posts. Called on fresh analyses (with posts) and on stored profiles.
 */
export function normalizeProfile(raw: unknown, stats: VoiceStats, posts: XPost[] = []): VoiceProfile {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Model output has the traits at the top level; a stored profile nests them.
  const traitSource = (input.traits && typeof input.traits === 'object' ? input.traits : input) as Record<string, unknown>;
  const grams = ngramSet(posts, 4);
  const keep = (items: string[]) => items.filter((item) => !copiesPosts(item, grams));

  const traits = Object.fromEntries(TRAIT_KEYS.map((key) => [key, keep(strings(traitSource[key], 4, 120))])) as Record<TraitKey, string[]>;
  const summary = keep(strings([input.summary], 1, 280))[0] || '';
  return { summary, traits, avoid: keep(strings(input.avoid, 6, 100)), stats };
}

function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Voice analysis returned no JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

/** One model call. The posts are sent to the AI service only, never stored or logged. */
export async function analyzeVoice(posts: XPost[], { budgetMs }: { budgetMs?: number } = {}): Promise<{ profile: VoiceProfile; model: string }> {
  const stats = computeStats(posts);
  const deadline = deadlineFrom(budgetMs);
  const listing = posts.map((p, i) => `[${i + 1}] ${clean(p.text)}`).join('\n\n');
  const measured = JSON.stringify(stats);

  const { value, model } = await withModelFallback(MODEL_CANDIDATES, 'Voice', async (modelName) => {
    const raw = await requestChatCompletion({
      modelName,
      deadline,
      thinking: false,
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: `MEASURED STATS:\n${measured}\n\nPOSTS:\n${listing}\n\nReturn ONLY the JSON object.` },
      ],
      temperature: 0.2,
      maxTokens: 1500,
    });
    const profile = normalizeProfile(parseJsonObject(raw), stats, posts);
    if (!profile.summary && TRAIT_KEYS.every((key) => profile.traits[key].length === 0)) {
      throw new Error('Voice analysis returned an empty profile.');
    }
    return profile;
  });

  return { profile: value, model };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Measured habits in plain words, for the writer and the settings page. */
export function measuredTraits(stats: VoiceStats): string[] {
  const out = [`Typical post length: about ${stats.medianChars} characters; about ${stats.wordsPerSentence} words per sentence`];
  if (stats.lowercaseStart >= 0.5) out.push(`Starts posts in lowercase (${pct(stats.lowercaseStart)} of posts)`);
  if (stats.multiLine >= 0.4) out.push(`Uses line breaks (${pct(stats.multiLine)} of posts)`);
  if (stats.lists >= 0.2) out.push(`Uses lists (${pct(stats.lists)} of posts)`);
  out.push(stats.emoji >= 0.3 ? `Uses emoji (${pct(stats.emoji)} of posts)` : stats.emoji <= 0.05 ? 'Almost never uses emoji' : `Uses emoji sparingly (${pct(stats.emoji)} of posts)`);
  if (stats.hashtags <= 0.05) out.push('Almost never uses hashtags');
  if (stats.exclamations <= 0.05) out.push('Almost never uses exclamation marks');
  else if (stats.exclamations >= 0.4) out.push(`Uses exclamation marks often (${pct(stats.exclamations)} of posts)`);
  if (stats.questions >= 0.3) out.push(`Often asks questions (${pct(stats.questions)} of posts)`);
  return out;
}

const LABELS: Record<TraitKey, string> = {
  tone: 'Tone',
  sentenceStyle: 'Sentences',
  vocabulary: 'Vocabulary',
  hooks: 'Hooks',
  structure: 'Structure',
  punctuation: 'Punctuation',
  emoji: 'Emoji',
  humor: 'Humor',
};

/** What the writer model receives: style only. */
export function voiceBrief(profile: VoiceProfile): string {
  const lines = [profile.summary && `Summary: ${profile.summary}`];
  for (const key of TRAIT_KEYS) {
    if (profile.traits[key].length) lines.push(`${LABELS[key]}: ${profile.traits[key].join('; ')}`);
  }
  lines.push(`Measured habits: ${measuredTraits(profile.stats).join('; ')}`);
  if (profile.avoid.length) lines.push(`Never: ${profile.avoid.join('; ')}`);
  return lines.filter(Boolean).join('\n');
}
