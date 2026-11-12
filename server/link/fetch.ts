import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { HttpError } from '../http.js';

// Fetches a URL the user pasted. The server makes the request, so this is an
// SSRF boundary: only http(s) on the standard ports, and every address the
// hostname resolves to must be public. The check runs inside the socket's own
// DNS lookup, so a hostname can't pass validation and then rebind to 127.0.0.1.

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 IdeaBird/1.0';

/** Tests point the fetcher at a local server; never set this in app code. */
export const linkFetchOptions = { allowPrivateHosts: false };

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6');
}

/** True for addresses on the public internet (not loopback, private, link-local, ...). */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses reach IPv4 hosts.
  const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isPublicAddress(embedded[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
    const [hi, lo] = lower.slice(7).split(':').map((part) => parseInt(part, 16));
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !BLOCKED.check(address, 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    if (!list.length || (!linkFetchOptions.allowPrivateHosts && list.some((a) => !isPublicAddress(a.address)))) {
      return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** Parses and checks a user-supplied URL. Throws a 400 the user can read. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new HttpError(400, "That doesn't look like a link. Paste the full address, e.g. https://youtube.com/watch?v=...");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http and https links are supported.');
  if (url.username || url.password) throw new HttpError(400, "Links with a username or password can't be read.");
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!linkFetchOptions.allowPrivateHosts) {
    if (net.isIP(host) && !isPublicAddress(host)) throw new HttpError(400, "IdeaBird can't read links to private or local addresses.");
    if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp)$/i.test(host)) {
      throw new HttpError(400, "IdeaBird can't read links to private or local addresses.");
    }
    if (url.port && url.port !== '80' && url.port !== '443') throw new HttpError(400, 'Only links on standard web ports can be read.');
  }
  url.hash = '';
  return url;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** GET (or POST) a public URL, following redirects, with size and time limits. */
export async function fetchPublic(rawUrl: string | URL, options: FetchOptions = {}): Promise<FetchedPage> {
  let url = parsePublicUrl(String(rawUrl));
  let method = options.method ?? 'GET';
  let body = options.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(url, { ...options, method, body });
    if (response.redirect) {
      url = parsePublicUrl(new URL(response.redirect, url).toString());
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { url: url.toString(), status: response.status, contentType: response.contentType, body: response.body };
  }
  throw new HttpError(422, 'That link redirects too many times.');
}

interface RawResponse {
  status: number;
  contentType: string;
  body: string;
  redirect?: string;
}

function requestOnce(url: URL, options: FetchOptions): Promise<RawResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: options.method ?? 'GET',
        lookup: safeLookup as unknown as typeof dns.lookup,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, contentType, body: '', redirect: res.headers.location });
        }
        const declared = Number(res.headers['content-length'] || 0);
        if (declared > maxBytes * 4) {
          res.destroy();
          return reject(new HttpError(422, 'That page is too large for IdeaBird to read.'));
        }

        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        const stream =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? res.pipe(zlib.createGunzip())
            : encoding === 'deflate'
              ? res.pipe(zlib.createInflate())
              : encoding === 'br'
                ? res.pipe(zlib.createBrotliDecompress())
                : res;

        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, contentType, body: decode(Buffer.concat(chunks), contentType) });
        };
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // Past the cap, keep what we have: the start of a page holds its content.
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', finish);
        stream.on('error', (err) => (done ? undefined : reject(fetchError(err))));
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(fetchError(err)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function fetchError(err: NodeJS.ErrnoException): HttpError {
  if (err instanceof HttpError) return err;
  if (err.code === 'EBLOCKED') return new HttpError(400, "IdeaBird can't read links to private or local addresses.");
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return new HttpError(422, "That website couldn't be found. Check the link.");
  if (err.code === 'ETIMEDOUT') return new HttpError(422, 'That website took too long to respond. Try again, or try another link.');
  return new HttpError(422, "IdeaBird couldn't open that link. Check it and try again.");
}

function decode(buffer: Buffer, contentType: string): string {
  let charset = contentType.match(/charset=["']?([\w-]+)/)?.[1];
  if (!charset) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}
