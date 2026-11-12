import { HttpError } from '../http.js';
import { fetchPublic, parsePublicUrl } from './fetch.js';

// Turns a pasted link into readable text: a YouTube transcript, an article's
// body, an X post or a Reddit thread. What comes back is untrusted page text;
// the analysis prompt treats it as data, never as instructions.

export type LinkKind = 'youtube' | 'article' | 'x' | 'reddit';

export interface LinkContent {
  kind: LinkKind;
  url: string;
  title: string;
  siteName: string;
  author: string;
  /** The readable content, already condensed to fit the model. */
  text: string;
  /** Shown to the user when the content is partial, e.g. a video without captions. */
  note: string;
}

/** Enough text to say something worth posting. */
const MIN_TEXT_CHARS = 200;
/** Longer sources (hour-long podcasts) are sampled evenly down to this. */
export const MAX_SOURCE_CHARS = 30_000;

export async function extractLink(rawUrl: string): Promise<LinkContent> {
  const url = parsePublicUrl(rawUrl);
  const videoId = youtubeVideoId(url);
  if (videoId) return finish(await extractYouTube(videoId));
  if (isXPost(url)) {
    const post = await extractXPost(url).catch(() => null);
    // A single post is short; the analysis still works from it.
    if (post) return finish(post, 20);
  }
  if (isRedditThread(url)) {
    const thread = await extractReddit(url).catch(() => null);
    if (thread) return finish(thread);
  }
  return finish(await extractArticle(url));
}

function finish(content: LinkContent, minChars = MIN_TEXT_CHARS): LinkContent {
  const text = condense(content.text.trim(), MAX_SOURCE_CHARS);
  if (text.length < minChars) {
    throw new HttpError(
      422,
      content.kind === 'youtube'
        ? "This video has no captions or description IdeaBird can read. Try a video with captions."
        : "IdeaBird couldn't find enough readable content at that link. It may need a login, or load its text with JavaScript."
    );
  }
  return { ...content, text, title: clean(content.title).slice(0, 300), siteName: clean(content.siteName).slice(0, 100), author: clean(content.author).slice(0, 100) };
}

/** Keeps evenly spaced windows of a long text, so the whole arc survives (not just the intro). */
export function condense(text: string, max: number): string {
  if (text.length <= max) return text;
  const windows = 6;
  const gap = '\n[…]\n';
  const size = Math.floor((max - gap.length * (windows - 1)) / windows);
  const stride = (text.length - size) / (windows - 1);
  const parts: string[] = [];
  for (let i = 0; i < windows; i += 1) {
    let start = Math.round(i * stride);
    // Start and end on word boundaries where possible.
    const space = text.indexOf(' ', start);
    if (i > 0 && space !== -1 && space - start < 40) start = space + 1;
    let part = text.slice(start, start + size);
    const lastSpace = part.lastIndexOf(' ');
    if (i < windows - 1 && lastSpace > size - 40) part = part.slice(0, lastSpace);
    parts.push(part.trim());
  }
  return parts.join(gap);
}

// --- YouTube -------------------------------------------------------------------

export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/)?.[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; shortDescription?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

/** Tests point this at a fake YouTube. */
export const youtubeEndpoints = { origin: 'https://www.youtube.com' };

async function extractYouTube(videoId: string): Promise<LinkContent> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  // The watch page carries the API key, metadata and (often) caption tracks.
  const page = await fetchPublic(`${youtubeEndpoints.origin}/watch?v=${videoId}&hl=en`, {
    headers: { Cookie: 'CONSENT=YES+cb; SOCS=CAI' },
  });
  const pagePlayer = parseJsonAssignment<PlayerResponse>(page.body, 'ytInitialPlayerResponse');
  const apiKey = page.body.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

  // The Android client's caption URLs work without the browser's proof-of-origin token.
  let player: PlayerResponse | null = null;
  try {
    const res = await fetchPublic(`${youtubeEndpoints.origin}/youtubei/v1/player?prettyPrint=false${apiKey ? `&key=${apiKey}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' } }, videoId }),
    });
    player = JSON.parse(res.body) as PlayerResponse;
  } catch {
    player = null;
  }

  const details = player?.videoDetails ?? pagePlayer?.videoDetails ?? {};
  const title = details.title || metaContent(page.body, 'og:title') || 'YouTube video';
  const author = details.author || page.body.match(/<link itemprop="name" content="([^"]+)"/)?.[1] || '';
  const description = details.shortDescription || pagePlayer?.videoDetails?.shortDescription || metaContent(page.body, 'og:description') || '';

  const status = player?.playabilityStatus?.status ?? pagePlayer?.playabilityStatus?.status;
  if (status && /^(ERROR|LOGIN_REQUIRED|UNPLAYABLE)$/.test(status) && !details.title) {
    throw new HttpError(422, "That YouTube video is private, age-restricted or unavailable, so IdeaBird can't read it.");
  }

  const tracks = [
    ...(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []),
    ...(pagePlayer?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []),
  ];
  let transcript = '';
  for (const track of rankTracks(tracks).slice(0, 3)) {
    try {
      const captionUrl = track.baseUrl.replace(/&fmt=[^&]+/, '');
      const res = await fetchPublic(captionUrl);
      transcript = parseCaptions(res.body);
      if (transcript.length >= MIN_TEXT_CHARS) break;
    } catch {
      // try the next track
    }
  }

  if (transcript.length >= MIN_TEXT_CHARS) {
    return {
      kind: 'youtube',
      url,
      title,
      siteName: 'YouTube',
      author,
      text: `${description ? `VIDEO DESCRIPTION:\n${description.slice(0, 1500)}\n\n` : ''}TRANSCRIPT:\n${transcript}`,
      note: '',
    };
  }
  return {
    kind: 'youtube',
    url,
    title,
    siteName: 'YouTube',
    author,
    text: description ? `VIDEO DESCRIPTION (no transcript available):\n${description}` : '',
    note: "This video's captions couldn't be read, so IdeaBird used its title and description.",
  };
}

/** English first (human captions over auto-generated), then anything human, then anything. */
function rankTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  const seen = new Set<string>();
  const unique = tracks.filter((t) => t.baseUrl && !seen.has(t.baseUrl) && seen.add(t.baseUrl));
  const score = (t: CaptionTrack) => (t.languageCode?.startsWith('en') ? 2 : 0) + (t.kind === 'asr' ? 0 : 1);
  return unique.sort((a, b) => score(b) - score(a));
}

/** YouTube timed text (both the classic <text> and the srv3 <p>/<s> formats) to plain prose. */
export function parseCaptions(xml: string): string {
  const cues = [...xml.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)].map((m) =>
    decodeEntities(decodeEntities(m[1].replace(/<[^>]+>/g, '')))
      .replace(/\s+/g, ' ')
      .trim()
  );
  const lines: string[] = [];
  for (const cue of cues) {
    if (!cue || /^\[(music|applause|laughter)\]$/i.test(cue)) continue;
    if (lines[lines.length - 1] !== cue) lines.push(cue);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function parseJsonAssignment<T>(html: string, name: string): T | null {
  const start = html.indexOf(`${name} = {`) >= 0 ? html.indexOf(`${name} = {`) + name.length + 3 : html.indexOf(`${name}={`) >= 0 ? html.indexOf(`${name}={`) + name.length + 1 : -1;
  if (start < 0) return null;
  const end = jsonObjectEnd(html, start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = inString;
    else if (char === '"') inString = !inString;
    else if (!inString && char === '{') depth += 1;
    else if (!inString && char === '}' && --depth === 0) return i;
  }
  return -1;
}

// --- X (Twitter) ---------------------------------------------------------------

function isXPost(url: URL): boolean {
  return /^(www\.|mobile\.)?(x|twitter)\.com$/.test(url.hostname) && /\/status(es)?\/\d+/.test(url.pathname);
}

async function extractXPost(url: URL): Promise<LinkContent | null> {
  const res = await fetchPublic(`https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url.toString())}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status !== 200) return null;
  const data = JSON.parse(res.body) as { author_name?: string; html?: string };
  const quote = data.html?.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/)?.[1] ?? '';
  // The post is the <p>; what follows it is the "— Name (@handle) date" footer.
  const postText = htmlToText((quote.match(/<p[^>]*>[\s\S]*?<\/p>/) ?? [''])[0]);
  if (!postText) return null;
  return {
    kind: 'x',
    url: url.toString(),
    title: `${data.author_name ?? 'Post'} on X`,
    siteName: 'X',
    author: data.author_name ?? '',
    text: `POST BY ${data.author_name ?? 'unknown'}:\n${postText}`,
    note: '',
  };
}

// --- Reddit --------------------------------------------------------------------

function isRedditThread(url: URL): boolean {
  return /(^|\.)reddit\.com$/.test(url.hostname) && /\/comments\/\w+/.test(url.pathname);
}

interface RedditThing {
  kind: string;
  data: { title?: string; selftext?: string; subreddit_name_prefixed?: string; author?: string; body?: string; score?: number };
}

async function extractReddit(url: URL): Promise<LinkContent | null> {
  const jsonUrl = `https://www.reddit.com${url.pathname.replace(/\/$/, '')}.json?limit=30&sort=top&raw_json=1`;
  const res = await fetchPublic(jsonUrl, { headers: { Accept: 'application/json' } });
  if (res.status !== 200) return null;
  const [postListing, commentListing] = JSON.parse(res.body) as { data: { children: RedditThing[] } }[];
  const post = postListing?.data.children[0]?.data;
  if (!post?.title) return null;
  const comments = (commentListing?.data.children ?? [])
    .filter((c) => c.kind === 't1' && c.data.body && c.data.body !== '[deleted]' && c.data.body !== '[removed]')
    .sort((a, b) => (b.data.score ?? 0) - (a.data.score ?? 0))
    .slice(0, 15)
    .map((c) => `- (${c.data.score ?? 0} points) ${c.data.body!.replace(/\s+/g, ' ').slice(0, 800)}`);
  return {
    kind: 'reddit',
    url: url.toString(),
    title: post.title,
    siteName: post.subreddit_name_prefixed ?? 'Reddit',
    author: post.author ? `u/${post.author}` : '',
    text: [`POST: ${post.title}`, post.selftext, comments.length ? `TOP COMMENTS:\n${comments.join('\n')}` : ''].filter(Boolean).join('\n\n'),
    note: '',
  };
}

// --- Articles, blog posts and any other web page ---------------------------------

async function extractArticle(url: URL): Promise<LinkContent> {
  const page = await fetchPublic(url);
  if (page.status === 401 || page.status === 403) {
    throw new HttpError(422, "That website blocked IdeaBird from reading the page. Try another link, or screenshot the part you want.");
  }
  if (page.status === 404 || page.status === 410) throw new HttpError(422, "That page doesn't exist (404). Check the link.");
  if (page.status >= 400) throw new HttpError(422, `That website answered with an error (${page.status}). Try again later.`);
  if (page.contentType.includes('application/pdf')) throw new HttpError(422, "PDF links aren't supported yet. Paste a web page or YouTube link.");
  if (page.contentType && !/text\/html|application\/xhtml|text\/plain/.test(page.contentType)) {
    throw new HttpError(422, "That link isn't a web page IdeaBird can read. Paste an article, blog post or YouTube link.");
  }

  const finalUrl = new URL(page.url);
  if (page.contentType.includes('text/plain')) {
    return { kind: 'article', url: page.url, title: finalUrl.pathname.split('/').pop() || finalUrl.hostname, siteName: finalUrl.hostname, author: '', text: page.body, note: '' };
  }
  const article = extractArticleFromHtml(page.body);
  return {
    kind: 'article',
    url: page.url,
    title: article.title || finalUrl.hostname,
    siteName: article.siteName || finalUrl.hostname.replace(/^www\./, ''),
    author: article.author,
    text: article.text,
    note: '',
  };
}

export interface ExtractedArticle {
  title: string;
  siteName: string;
  author: string;
  description: string;
  text: string;
}

/** A small readability pass: metadata, then the main text from JSON-LD, <article>, <main> or <body>. */
export function extractArticleFromHtml(html: string): ExtractedArticle {
  const title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const siteName = metaContent(html, 'og:site_name') || metaContent(html, 'application-name');
  const description = metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description');
  const ld = jsonLdArticle(html);
  const author = metaContent(html, 'author') || metaContent(html, 'article:author') || ld.author;

  let text = ld.body.length > 600 ? ld.body : '';
  if (!text) {
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|form|button|select|canvas|figure)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
    const region = largestMatch(cleaned, /<article\b[\s\S]*?<\/article>/gi) || largestMatch(cleaned, /<main\b[\s\S]*?<\/main>/gi) || cleaned.match(/<body\b[\s\S]*<\/body>/i)?.[0] || cleaned;
    text = blocksToText(region);
  }
  // Pages that load their text with JavaScript still have a description.
  if (text.length < MIN_TEXT_CHARS && description) text = `${description}\n\n${text}`.trim();
  return { title, siteName, author, description, text };
}

function largestMatch(html: string, pattern: RegExp): string {
  let best = '';
  for (const match of html.matchAll(pattern)) if (match[0].length > best.length) best = match[0];
  return best;
}

/** Block-level HTML to paragraphs, dropping menu-like fragments. */
function blocksToText(html: string): string {
  const withBreaks = html
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n## ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|ul|ol|blockquote|tr|pre|dd|dt)>/gi, '\n');
  const lines = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => {
      const words = line.replace(/^(## |- )/, '').split(' ').length;
      return line.startsWith('## ') ? words >= 2 : words >= 6 || /[.!?:"”]$/.test(line);
    });
  const seen = new Set<string>();
  return lines.filter((line) => !seen.has(line) && seen.add(line)).join('\n').replace(/\n{3,}/g, '\n\n');
}

function jsonLdArticle(html: string): { body: string; author: string } {
  let body = '';
  let author = '';
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const obj = node as Record<string, unknown>;
    if (typeof obj.articleBody === 'string' && obj.articleBody.length > body.length) body = obj.articleBody;
    if (!author && obj.author) {
      const a = Array.isArray(obj.author) ? obj.author[0] : obj.author;
      author = typeof a === 'string' ? a : typeof (a as { name?: unknown })?.name === 'string' ? (a as { name: string }).name : '';
    }
    if (obj['@graph']) visit(obj['@graph']);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1].trim()));
    } catch {
      // invalid JSON-LD is common; skip it
    }
  }
  return { body: decodeEntities(body).replace(/[ \t]+/g, ' ').trim(), author };
}

export function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const tag of html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'gi')) ?? []) {
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? tag.match(/content="([^"]*)"/i)?.[1];
    if (content) return clean(decodeEntities(content));
  }
  return '';
}

function htmlToText(html: string): string {
  return clean(decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}
