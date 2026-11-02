import { Router, type Response } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { aiBudgetMs } from '../generate/routes.js';
import { HttpError, parseBody } from '../http.js';
import { rateLimit } from '../security/rateLimit.js';
import { accessTokenFor, decrypt, deleteConnection, encrypt, getConnection, markExpired, ReconnectRequired, saveConnection, sha256 } from './connection.js';
import { PLANS, type PlanId } from '../../shared/plans.js';
import { analyzeVoice, measuredTraits, MIN_POSTS, normalizeProfile } from './profile.js';
import { loadProfile } from './store.js';
import { buildAuthorizeUrl, exchangeCode, fetchRecentPosts, getMe, randomToken, XApiError } from './xClient.js';

export const voiceRouter = Router();

// While Write Like Me is hidden (WRITE_LIKE_ME isn't "on"), the status call tells
// the app to hide it and every other endpoint doesn't exist.
voiceRouter.use((req, res, next) => {
  if (config().writeLikeMe) return next();
  if (req.method === 'GET' && req.path === '/') return res.json({ hidden: true });
  return res.status(404).json({ error: 'Not found.' });
});

const STATE_TTL_MINUTES = 10;
// Binds the OAuth round trip to the browser that started it, so a victim can't be
// tricked into finishing someone else's authorization (and connecting their X
// account to the attacker's IdeaBird account). Lax: sent on X's top-level redirect back.
const NONCE_COOKIE = 'ib_xs';
const CALLBACK_PATH = '/api/voice/x/callback';

export const VOICE_MESSAGES = {
  denied: "X wasn't connected. You can still use IdeaBird without Write Like Me.",
  tooFew: "We couldn't find enough posts to learn your writing style yet.",
  reconnect: 'Your X connection needs to be refreshed.',
};

function assertConfigured() {
  if (!config().xClientId) throw new HttpError(503, 'Write Like Me is not set up on this server.');
}

const proOnly = (plan: PlanId) => !(PLANS[plan] ?? PLANS.free).limits.writeLikeMe;

/** Write Like Me is Pro. Disconnecting (and seeing the status) stays open to everyone. */
function assertPro(plan: PlanId, res: Response): boolean {
  if (!proOnly(plan)) return true;
  res.status(403).json({ code: 'pro_required', error: 'Write Like Me is part of IdeaBird Pro.' });
  return false;
}

/** The current user's Write Like Me state. Only ever their own connection and profile. */
async function status(userId: string, plan: PlanId) {
  const [connection, row] = await Promise.all([getConnection(userId), loadProfile(userId)]);
  const profile = row ? normalizeProfile(row.profile, row.profile.stats) : null;
  return {
    available: Boolean(config().xClientId),
    /** False on Free: the app shows the upgrade card instead. */
    pro: !proOnly(plan),
    connection: connection ? { username: connection.username, status: connection.status } : null,
    profile:
      row && profile
        ? {
            summary: profile.summary,
            traits: profile.traits,
            avoid: profile.avoid,
            measured: measuredTraits(profile.stats),
            postCount: row.post_count,
            enabled: row.enabled,
            updatedAt: new Date(row.updated_at).toISOString(),
          }
        : null,
  };
}

voiceRouter.get('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  res.json(await status(user.id, user.plan));
});

/** Starts the X authorization: returns X's consent URL for the browser to open. */
voiceRouter.post('/connect', requireAuth, async (req, res) => {
  assertConfigured();
  const user = currentUser(req);
  if (!assertPro(user.plan, res)) return;
  await rateLimit({ key: `voice-connect:${user.id}`, max: 10, windowSeconds: 60 * 60 });

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  await query(`DELETE FROM x_oauth_states WHERE user_id = $1 OR expires_at < now()`, [user.id]);
  await query(
    `INSERT INTO x_oauth_states (state_hash, user_id, nonce_hash, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [sha256(state), user.id, sha256(nonce), encrypt(codeVerifier), STATE_TTL_MINUTES]
  );

  res.cookie(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: config().isProduction,
    sameSite: 'lax',
    path: CALLBACK_PATH,
    maxAge: STATE_TTL_MINUTES * 60 * 1000,
  });
  res.json({ url: buildAuthorizeUrl(state, codeVerifier) });
});

/**
 * X redirects the browser here. There's no bearer token on a top-level
 * navigation: the user comes from the single-use state row, which must also
 * match this browser's nonce cookie. Always ends with a redirect into the app.
 */
voiceRouter.get('/x/callback', async (req, res) => {
  const back = (result: string) => {
    res.clearCookie(NONCE_COOKIE, { path: CALLBACK_PATH });
    res.redirect(303, `${config().appUrl}/?voice=${result}`);
  };
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const nonce = typeof req.cookies?.[NONCE_COOKIE] === 'string' ? (req.cookies[NONCE_COOKIE] as string) : '';
  if (!config().xClientId || !state) return back('invalid');

  // Single use: consumed whatever happens next.
  const [row] = await query<{ user_id: string; nonce_hash: string; code_verifier: string; expired: boolean }>(
    `DELETE FROM x_oauth_states WHERE state_hash = $1 RETURNING user_id, nonce_hash, code_verifier, expires_at < now() AS expired`,
    [sha256(state)]
  );
  if (!row || row.expired || !nonce || sha256(nonce) !== row.nonce_hash) return back('invalid');

  if (req.query.error || !code) return back('denied');

  const codeVerifier = decrypt(row.code_verifier);
  if (!codeVerifier) return back('invalid');

  try {
    const tokens = await exchangeCode(code, codeVerifier);
    const me = await getMe(tokens.accessToken);
    // A different X account than before: its old profile must not carry over.
    const previous = await getConnection(row.user_id);
    if (previous && previous.xUserId !== me.id) {
      await query(`DELETE FROM voice_profiles WHERE user_id = $1`, [row.user_id]);
    }
    await saveConnection(row.user_id, me, tokens);
    return back('connected');
  } catch (err) {
    console.error(`[IdeaBird] X connect failed: ${err instanceof XApiError ? err.kind : 'error'}`);
    return back('failed');
  }
});

function sendVoiceError(res: Response, err: unknown) {
  if (err instanceof ReconnectRequired) {
    return res.status(409).json({ code: 'reconnect', error: VOICE_MESSAGES.reconnect });
  }
  if (err instanceof XApiError) {
    // err.message holds the endpoint and HTTP status only (no tokens, no post text).
    console.error(`[IdeaBird] X API error (${err.kind}): ${err.message}`);
    if (err.kind === 'no_credits') {
      console.error('[IdeaBird] The X developer account has no API credits left. Add credits at https://developer.x.com to re-enable Write Like Me.');
      return res.status(503).json({
        code: 'x_no_credits',
        error: "Write Like Me can't read posts from X right now. It's a temporary limit on IdeaBird's side, not your account. Your posts still use IdeaBird's default voice.",
      });
    }
    if (err.kind === 'rate_limited') {
      const minutes = err.resetAt ? Math.max(1, Math.ceil((err.resetAt - Date.now()) / 60000)) : 15;
      res.set('Retry-After', String(minutes * 60));
      return res.status(429).json({
        code: 'x_rate_limited',
        error: `X is limiting requests right now. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Your posts still use IdeaBird's default voice.`,
      });
    }
    if (err.kind === 'forbidden') {
      return res.status(502).json({
        code: 'x_forbidden',
        error: "X didn't let IdeaBird read your posts. Your posts will use IdeaBird's default voice for now.",
      });
    }
    return res.status(502).json({
      code: 'x_unavailable',
      error: "Couldn't reach X right now. Try again in a moment. Your posts still use IdeaBird's default voice.",
    });
  }
  if (err instanceof HttpError) throw err;
  // The AI service failed while analyzing. Keep any previous profile.
  console.error('[IdeaBird] Voice analysis failed:', (err as Error)?.message?.slice(0, 140));
  return res.status(502).json({
    code: 'analysis_failed',
    error: "We couldn't analyze your writing style right now. Try again in a moment. Your posts still use IdeaBird's default voice.",
  });
}

/**
 * Fetches recent posts and (re)builds the Voice Profile. Runs only on connect and
 * when the user taps "Refresh my voice", never during generation.
 */
voiceRouter.post('/refresh', requireAuth, async (req, res) => {
  assertConfigured();
  const user = currentUser(req);
  if (!assertPro(user.plan, res)) return;
  await rateLimit({
    key: `voice-refresh:${user.id}`,
    max: 6,
    windowSeconds: 60 * 60,
    message: 'You have refreshed your voice a lot this hour. Try again later.',
  });

  try {
    const { accessToken, xUserId } = await accessTokenFor(user.id);
    let posts;
    try {
      posts = await fetchRecentPosts(accessToken, xUserId);
    } catch (err) {
      // Revoked in X's settings: the stored token no longer works.
      if (err instanceof XApiError && err.kind === 'unauthorized') {
        await markExpired(user.id);
        throw new ReconnectRequired();
      }
      throw err;
    }

    if (posts.length < MIN_POSTS) {
      return res.status(422).json({ code: 'too_few_posts', error: VOICE_MESSAGES.tooFew, postCount: posts.length });
    }

    const { profile, model } = await analyzeVoice(posts, { budgetMs: aiBudgetMs() });
    console.log(`[IdeaBird] Voice profile built from ${posts.length} posts.`);
    await query(
      `INSERT INTO voice_profiles (user_id, profile, post_count, model) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET profile = EXCLUDED.profile, post_count = EXCLUDED.post_count,
         model = EXCLUDED.model, updated_at = now()`,
      [user.id, JSON.stringify(profile), posts.length, model]
    );
    return res.json(await status(user.id, user.plan));
  } catch (err) {
    return sendVoiceError(res, err);
  }
});

voiceRouter.patch('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  if (!assertPro(user.plan, res)) return;
  const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req.body);
  const updated = await query(`UPDATE voice_profiles SET enabled = $2 WHERE user_id = $1 RETURNING user_id`, [user.id, enabled]);
  if (!updated.length) throw new HttpError(404, 'Connect X first so IdeaBird can learn your voice.');
  res.json(await status(user.id, user.plan));
});

/** Disconnect X: revokes the tokens and deletes the profile. */
voiceRouter.delete('/', requireAuth, async (req, res) => {
  const user = currentUser(req);
  await deleteConnection(user.id);
  res.json(await status(user.id, user.plan));
});

