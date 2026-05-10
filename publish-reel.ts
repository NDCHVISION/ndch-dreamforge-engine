/**
 * NDCH Vision — Instagram Reel Publisher
 * Meta Graph API v19.0  |  Facebook Login for Business route
 *
 * Required app permissions (as shown in Meta App Dashboard)
 * ──────────────────────────────────────────────────────────
 *   instagram_basic
 *   instagram_content_publish
 *   pages_read_engagement
 *   business_management
 *   pages_show_list
 *
 * Env var responsibilities
 * ────────────────────────
 *   INSTAGRAM_PAGE_TOKEN     Long-lived Page Access Token — used for ALL
 *                            Graph API calls (container create, status poll,
 *                            media publish). Derive it once with refreshPageToken().
 *
 *   IG_BUSINESS_ACCOUNT_ID   The Instagram Business Account ID (not the FB Page ID).
 *                            This is the actual target for every publish endpoint:
 *                              POST /{IG_BUSINESS_ACCOUNT_ID}/media
 *                              POST /{IG_BUSINESS_ACCOUNT_ID}/media_publish
 *
 *   META_APP_ID              Used only in refreshPageToken() to exchange tokens.
 *   META_APP_SECRET          Used only in refreshPageToken() to exchange tokens.
 *   FB_PAGE_ID               Used only in refreshPageToken() to look up the correct
 *                            Page Access Token when a user manages multiple Pages.
 *                            NOT used in any publish endpoint.
 *
 * Per-run env vars
 * ────────────────
 *   REEL_VIDEO_URL           Publicly reachable .mp4 (H.264/AAC, 9:16, 3–90 s)
 *   REEL_CAPTION             Caption text (≤ 2 200 chars; hashtags included)
 *
 * Node ≥ 18 required (native fetch).
 */

// ── Env validation ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`✗  Missing required env var: ${name}`); process.exit(1); }
  return v;
}

const PAGE_TOKEN   = requireEnv('INSTAGRAM_PAGE_TOKEN');
const IG_ACCT_ID   = requireEnv('IG_BUSINESS_ACCOUNT_ID'); // 17841463257757058
const APP_ID       = requireEnv('META_APP_ID');             // 1966454147334333
const APP_SECRET   = requireEnv('META_APP_SECRET');
const FB_PAGE_ID   = requireEnv('FB_PAGE_ID');              // 782632291594234

const GRAPH        = 'https://graph.facebook.com/v19.0';
const POLL_EVERY   = 5_000;   // ms
const POLL_TIMEOUT = 120_000; // ms — 2 min ceiling

// ── Types ─────────────────────────────────────────────────────────────────────

type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'EXPIRED' | 'ERROR' | 'PUBLISHED';

interface MetaErrorPayload {
  message:        string;
  type:           string;
  code:           number;
  error_subcode?: number;
  fbtrace_id?:    string;
}

interface ReelOptions {
  videoUrl:      string;
  caption?:      string;
  shareToFeed?:  boolean;  // default true — also posts to main feed grid
  thumbOffset?:  number;   // ms into video to use as cover frame
}

// ── Error class ───────────────────────────────────────────────────────────────

class MetaError extends Error {
  readonly code:    number;
  readonly subcode: number | undefined;
  readonly traceId: string | undefined;

  constructor(e: MetaErrorPayload) {
    super(
      `Meta [${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}] ${e.message}` +
      (hint(e.code, e.error_subcode) ? `\n  → ${hint(e.code, e.error_subcode)}` : '')
    );
    this.name    = 'MetaError';
    this.code    = e.code;
    this.subcode = e.error_subcode;
    this.traceId = e.fbtrace_id;
  }
}

function hint(code: number, sub?: number): string {
  // https://developers.facebook.com/docs/graph-api/guides/error-handling
  const map: Record<string, string> = {
    '10':       'instagram_content_publish not approved — submit for App Review',
    '100':      'Invalid parameter — check video_url is public and video meets spec (H.264, AAC, .mp4, 9:16, 3-90 s)',
    '190':      'Access token invalid — run refreshPageToken() to get a fresh one',
    '190/460':  'Token expired — refresh INSTAGRAM_PAGE_TOKEN',
    '190/463':  'Session invalidated — user changed password or revoked app',
    '200':      'Permission denied — ensure business_management + instagram_content_publishing are approved',
    '24':       'App-level throttle — back off for 1 hour',
    '32':       'Page-level rate limit — reduce request frequency',
    '368':      'Account blocked — check Meta Business Support',
    '2207026':  'Video URL unreachable — Meta servers must be able to GET it without auth',
    '2207001':  'Unsupported video format — must be H.264 + AAC in .mp4',
    '2207050':  'Duration out of range — Reels must be 3–90 seconds',
  };
  const k = sub ? `${code}/${sub}` : String(code);
  return map[k] ?? map[String(code)] ?? '';
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function gql<T>(
  path: string,
  method: 'GET' | 'POST',
  params: Record<string, string> = {}
): Promise<T> {
  const url  = new URL(`${GRAPH}${path}`);
  let   body: string | undefined;

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    body = new URLSearchParams(params).toString();
  }

  const res  = await fetch(url.toString(), {
    method,
    headers: method === 'POST'
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : undefined,
    body,
  });
  const json = await res.json() as T & { error?: MetaErrorPayload };
  if (json.error) throw new MetaError(json.error);
  return json;
}

// ── Token helpers (Facebook Login route) ─────────────────────────────────────
//
// Facebook Login flow:
//   1. User authorises your app → short-lived User Access Token
//   2. Exchange for long-lived User Access Token (60-day):
//        GET /oauth/access_token?grant_type=fb_exchange_token
//   3. Retrieve Page Access Token from the FB Page:
//        GET /{fb-page-id}?fields=access_token
//   4. Store that as INSTAGRAM_PAGE_TOKEN.
//
// Page Access Tokens derived from a long-lived User Token never expire
// — but if your User Token expires you must redo steps 1-3.
//
// Use refreshPageToken() in a scheduled job before the 60-day window closes.

/**
 * Exchange a short-lived user token for a long-lived one, then fetch
 * the Page Access Token. Returns the Page token to store as
 * INSTAGRAM_PAGE_TOKEN.
 *
 * Call this once to bootstrap, then again ~every 50 days.
 */
export async function refreshPageToken(shortLivedUserToken: string): Promise<string> {
  // Step 1: long-lived user token
  const { access_token: longToken } = await gql<{ access_token: string }>(
    '/oauth/access_token',
    'GET',
    {
      grant_type:        'fb_exchange_token',
      client_id:         APP_ID,
      client_secret:     APP_SECRET,
      fb_exchange_token: shortLivedUserToken,
    }
  );

  // Step 2: page token from the FB Page
  const { access_token: pageToken } = await gql<{ access_token: string }>(
    `/${FB_PAGE_ID}`,
    'GET',
    { fields: 'access_token', access_token: longToken }
  );

  return pageToken;
}

// ── Step 1: Create Reel container ─────────────────────────────────────────────

async function createContainer(opts: ReelOptions): Promise<string> {
  console.log('  [1/3] Creating Reel container…');

  const params: Record<string, string> = {
    media_type:    'REELS',
    video_url:     opts.videoUrl,
    share_to_feed: String(opts.shareToFeed ?? true),
    access_token:  PAGE_TOKEN,
  };
  if (opts.caption)                   params.caption      = opts.caption;
  if (opts.thumbOffset !== undefined) params.thumb_offset = String(opts.thumbOffset);

  const { id } = await gql<{ id: string }>(
    `/${IG_ACCT_ID}/media`,
    'POST',
    params
  );

  console.log(`         container: ${id}`);
  return id;
}

// ── Step 2: Poll until FINISHED ───────────────────────────────────────────────

async function waitForContainer(containerId: string): Promise<void> {
  console.log('  [2/3] Waiting for processing…');

  const deadline = Date.now() + POLL_TIMEOUT;
  let   attempt  = 0;

  while (Date.now() < deadline) {
    attempt++;

    const { status_code, status } = await gql<{
      status_code: ContainerStatus;
      status:      string;
      id:          string;
    }>(
      `/${containerId}`,
      'GET',
      { fields: 'status_code,status', access_token: PAGE_TOKEN }
    );

    console.log(`         [${attempt}] ${status_code}`);

    if (status_code === 'FINISHED')    return;
    if (status_code === 'IN_PROGRESS') { await sleep(POLL_EVERY); continue; }
    if (status_code === 'EXPIRED')
      throw new Error('Container expired before publishing — re-upload the video');
    if (status_code === 'ERROR')
      throw new Error(`Container processing failed: ${status ?? 'unknown'}`);
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT / 1000}s — try a shorter video or retry later`);
}

// ── Step 3: Publish ───────────────────────────────────────────────────────────

async function publishContainer(containerId: string): Promise<string> {
  console.log('  [3/3] Publishing…');

  const { id } = await gql<{ id: string }>(
    `/${IG_ACCT_ID}/media_publish`,
    'POST',
    { creation_id: containerId, access_token: PAGE_TOKEN }
  );

  return id;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Publish a Reel. Returns the published Instagram media ID. */
export async function publishReel(opts: ReelOptions): Promise<string> {
  const containerId = await createContainer(opts);
  await waitForContainer(containerId);
  return publishContainer(containerId);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function optionalBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }
  return parsed;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

const videoUrl = process.env.REEL_VIDEO_URL;
const caption  = process.env.REEL_CAPTION;
const thumbOffset = optionalNumberEnv('REEL_THUMB_OFFSET_MS');
const shareToFeed = optionalBooleanEnv('REEL_SHARE_TO_FEED') ?? true;

if (!videoUrl) {
  console.error('✗  Missing REEL_VIDEO_URL');
  process.exit(1);
}

console.log('NDCH Vision — Reel Publisher');
console.log(`  ig account : ${IG_ACCT_ID}`);
console.log(`  fb page    : ${FB_PAGE_ID}`);
console.log(`  video      : ${videoUrl}`);
console.log('');

publishReel({ videoUrl, caption, shareToFeed, thumbOffset })
  .then(mediaId => {
    console.log('');
    console.log(`✓  Reel live — media id: ${mediaId}`);
  })
  .catch(err => {
    console.error('');
    console.error('✗  Publish failed:', err.message);
    if (err instanceof MetaError && err.traceId) {
      console.error('   Meta trace id:', err.traceId);
      console.error('   Share trace id with Meta support if this persists.');
    }
    process.exit(1);
  });
