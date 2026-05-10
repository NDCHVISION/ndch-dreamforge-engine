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

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { requestJson } from './http-client.ts';

const GRAPH = 'https://graph.facebook.com/v19.0';
const POLL_EVERY = 5_000;
const POLL_TIMEOUT = 120_000;

interface PublisherConfig {
  pageToken: string;
  igAccountId: string;
  appId: string;
  appSecret: string;
  fbPageId: string;
}

let publisherConfig: PublisherConfig | undefined;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function loadPublisherConfig(env: NodeJS.ProcessEnv = process.env): PublisherConfig {
  return {
    pageToken: requireEnv(env, 'INSTAGRAM_PAGE_TOKEN'),
    igAccountId: requireEnv(env, 'IG_BUSINESS_ACCOUNT_ID'),
    appId: requireEnv(env, 'META_APP_ID'),
    appSecret: requireEnv(env, 'META_APP_SECRET'),
    fbPageId: requireEnv(env, 'FB_PAGE_ID'),
  };
}

function getConfig(): PublisherConfig {
  publisherConfig ??= loadPublisherConfig(process.env);
  return publisherConfig;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'EXPIRED' | 'ERROR' | 'PUBLISHED';

interface MetaErrorPayload {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

interface ReelOptions {
  videoUrl: string;
  caption?: string;
  shareToFeed?: boolean;
  thumbOffset?: number;
}

// ── Error class ───────────────────────────────────────────────────────────────

class MetaError extends Error {
  readonly code: number;
  readonly subcode: number | undefined;
  readonly traceId: string | undefined;

  constructor(e: MetaErrorPayload) {
    super(
      `Meta [${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}] ${e.message}` +
      (hint(e.code, e.error_subcode) ? `\n  → ${hint(e.code, e.error_subcode)}` : '')
    );
    this.name = 'MetaError';
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.traceId = e.fbtrace_id;
  }
}

function hint(code: number, sub?: number): string {
  const map: Record<string, string> = {
    '10': 'instagram_content_publish not approved — submit for App Review',
    '100': 'Invalid parameter — check video_url is public and video meets spec (H.264, AAC, .mp4, 9:16, 3-90 s)',
    '190': 'Access token invalid — run refreshPageToken() to get a fresh one',
    '190/460': 'Token expired — refresh INSTAGRAM_PAGE_TOKEN',
    '190/463': 'Session invalidated — user changed password or revoked app',
    '200': 'Permission denied — ensure business_management + instagram_content_publishing are approved',
    '24': 'App-level throttle — back off for 1 hour',
    '32': 'Page-level rate limit — reduce request frequency',
    '368': 'Account blocked — check Meta Business Support',
    '2207026': 'Video URL unreachable — Meta servers must be able to GET it without auth',
    '2207001': 'Unsupported video format — must be H.264 + AAC in .mp4',
    '2207050': 'Duration out of range — Reels must be 3–90 seconds',
  };
  const key = sub ? `${code}/${sub}` : String(code);
  return map[key] ?? map[String(code)] ?? '';
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function gql<T>(
  path: string,
  method: 'GET' | 'POST',
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  let body: string | undefined;

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    body = new URLSearchParams(params).toString();
  }

  const json = await requestJson<T & { error?: MetaErrorPayload }>(url.toString(), {
    method,
    headers: method === 'POST'
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : undefined,
    body,
    timeoutMs: 30_000,
    maxRetries: 3,
  });

  if (json.error) throw new MetaError(json.error);
  return json;
}

// ── Token helpers (Facebook Login route) ─────────────────────────────────────

export async function refreshPageToken(shortLivedUserToken: string): Promise<string> {
  const config = getConfig();

  const { access_token: longToken } = await gql<{ access_token: string }>(
    '/oauth/access_token',
    'GET',
    {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLivedUserToken,
    }
  );

  const { access_token: pageToken } = await gql<{ access_token: string }>(
    `/${config.fbPageId}`,
    'GET',
    { fields: 'access_token', access_token: longToken }
  );

  return pageToken;
}

// ── Step 1: Create Reel container ─────────────────────────────────────────────

async function createContainer(opts: ReelOptions): Promise<string> {
  const config = getConfig();
  console.log('  [1/3] Creating Reel container…');

  const params: Record<string, string> = {
    media_type: 'REELS',
    video_url: opts.videoUrl,
    share_to_feed: String(opts.shareToFeed ?? true),
    access_token: config.pageToken,
  };
  if (opts.caption) params.caption = opts.caption;
  if (opts.thumbOffset !== undefined) params.thumb_offset = String(opts.thumbOffset);

  const { id } = await gql<{ id: string }>(
    `/${config.igAccountId}/media`,
    'POST',
    params
  );

  console.log(`         container: ${id}`);
  return id;
}

// ── Step 2: Poll until FINISHED ───────────────────────────────────────────────

async function waitForContainer(containerId: string): Promise<void> {
  const config = getConfig();
  console.log('  [2/3] Waiting for processing…');

  const deadline = Date.now() + POLL_TIMEOUT;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    const { status_code, status } = await gql<{
      status_code: ContainerStatus;
      status: string;
      id: string;
    }>(
      `/${containerId}`,
      'GET',
      { fields: 'status_code,status', access_token: config.pageToken }
    );

    console.log(`         [${attempt}] ${status_code}`);

    if (status_code === 'FINISHED') return;
    if (status_code === 'IN_PROGRESS') {
      await sleep(POLL_EVERY);
      continue;
    }
    if (status_code === 'EXPIRED') {
      throw new Error('Container expired before publishing — re-upload the video');
    }
    if (status_code === 'ERROR') {
      throw new Error(`Container processing failed: ${status ?? 'unknown'}`);
    }
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT / 1000}s — try a shorter video or retry later`);
}

// ── Step 3: Publish ───────────────────────────────────────────────────────────

async function publishContainer(containerId: string): Promise<string> {
  const config = getConfig();
  console.log('  [3/3] Publishing…');

  const { id } = await gql<{ id: string }>(
    `/${config.igAccountId}/media_publish`,
    'POST',
    { creation_id: containerId, access_token: config.pageToken }
  );

  return id;
}

// ── Public API ────────────────────────────────────────────────────────────────

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

async function runCli(): Promise<void> {
  const config = getConfig();
  const videoUrl = process.env.REEL_VIDEO_URL?.trim();
  const caption = process.env.REEL_CAPTION;
  const thumbOffset = optionalNumberEnv('REEL_THUMB_OFFSET_MS');
  const shareToFeed = optionalBooleanEnv('REEL_SHARE_TO_FEED') ?? true;

  if (!videoUrl) throw new Error('Missing required env var: REEL_VIDEO_URL');

  console.log('NDCH Vision — Reel Publisher');
  console.log(`  ig account : ${config.igAccountId}`);
  console.log(`  fb page    : ${config.fbPageId}`);
  console.log(`  video      : ${videoUrl}`);
  console.log('');

  const mediaId = await publishReel({ videoUrl, caption, shareToFeed, thumbOffset });
  console.log('');
  console.log(`✓  Reel live — media id: ${mediaId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch(err => {
    console.error('');
    console.error('✗  Publish failed:', err instanceof Error ? err.message : String(err));
    if (err instanceof MetaError && err.traceId) {
      console.error('   Meta trace id:', err.traceId);
      console.error('   Share trace id with Meta support if this persists.');
    }
    process.exit(1);
  });
}
