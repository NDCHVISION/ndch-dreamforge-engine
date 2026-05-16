import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveProductionPlan, type ResolvedProductionPlan } from '../reel-plan.ts';

const MIN_RUNWAY_CONCURRENCY = 1;
const MAX_RUNWAY_CONCURRENCY = 4;

export interface GenerateRuntimeDefaults {
  defaultVoiceId: string;
  defaultModelId: string;
  releaseTag?: string;
  releaseName?: string;
  runwayConcurrency?: number;
}

export interface GenerateRuntimeConfig {
  elevenLabsKey: string;
  runwayKey: string;
  githubToken: string;
  releaseRepo: string;
  releaseTag: string;
  releaseName: string;
  runwayConcurrency: number;
  musicPath?: string;
  plan: ResolvedProductionPlan;
}

export interface PublishRuntimeConfig {
  pageToken: string;
  igAccountId: string;
  appId: string;
  appSecret: string;
  fbPageId: string;
  videoUrl?: string;
  caption?: string;
  thumbOffset?: number;
  shareToFeed?: boolean;
  coverUrl?: string;
}

export function getRequiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = getOptionalString(env, name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function getOptionalNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { integer?: boolean; min?: number; max?: number } = {}
): number | undefined {
  const value = getOptionalString(env, name);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid integer env var ${name}: ${value}`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid numeric env var ${name}: ${value} (minimum ${options.min})`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Invalid numeric env var ${name}: ${value} (maximum ${options.max})`);
  }

  return parsed;
}

export function getOptionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = getOptionalString(env, name);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

export function validateRepositorySlug(value: string, name = 'repository'): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

export function validateHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL env var ${name}: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid URL env var ${name}: ${value}`);
  }

  return url.toString();
}

export function validateExistingPath(pathValue: string, name: string): string {
  const resolvedPath = resolve(pathValue);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Configured path for ${name} does not exist: ${resolvedPath}`);
  }
  return resolvedPath;
}

export function loadGenerateRuntimeConfig(
  env: NodeJS.ProcessEnv,
  defaults: GenerateRuntimeDefaults
): GenerateRuntimeConfig {
  const validatedEnv = { ...env };
  const engineConfigPath = getOptionalString(env, 'ENGINE_CONFIG_PATH');
  const reelSpecPath = getOptionalString(env, 'REEL_SPEC_PATH');
  const musicPath = getOptionalString(env, 'REEL_MUSIC_PATH');

  if (engineConfigPath) {
    validatedEnv.ENGINE_CONFIG_PATH = validateExistingPath(engineConfigPath, 'ENGINE_CONFIG_PATH');
  }
  if (reelSpecPath) {
    validatedEnv.REEL_SPEC_PATH = validateExistingPath(reelSpecPath, 'REEL_SPEC_PATH');
  }
  const resolvedMusicPath = musicPath
    ? validateExistingPath(musicPath, 'REEL_MUSIC_PATH')
    : undefined;

  const releaseRepo = validateRepositorySlug(
    getOptionalString(env, 'REEL_RELEASE_REPO') ?? getRequiredString(env, 'GITHUB_REPOSITORY'),
    'repository slug'
  );
  const releaseTag = getOptionalString(env, 'REEL_RELEASE_TAG') ?? defaults.releaseTag ?? 'reel-latest';
  const releaseName = getOptionalString(env, 'REEL_RELEASE_NAME') ?? defaults.releaseName ?? 'NDCH Dreamforge Latest Reel';
  const runwayConcurrency = getOptionalNumber(env, 'REEL_RUNWAY_CONCURRENCY', {
    integer: true,
    min: MIN_RUNWAY_CONCURRENCY,
    max: MAX_RUNWAY_CONCURRENCY,
  }) ?? defaults.runwayConcurrency ?? 2;

  return {
    elevenLabsKey: getRequiredString(env, 'ELEVENLABS_API_KEY'),
    runwayKey: getRequiredString(env, 'RUNWAY_API_KEY'),
    githubToken: getRequiredString(env, 'GITHUB_TOKEN'),
    releaseRepo,
    releaseTag,
    releaseName,
    runwayConcurrency,
    musicPath: resolvedMusicPath,
    plan: resolveProductionPlan(validatedEnv, {
      defaultVoiceId: defaults.defaultVoiceId,
      defaultModelId: defaults.defaultModelId,
    }),
  };
}

export function loadPublishRuntimeConfig(env: NodeJS.ProcessEnv): PublishRuntimeConfig {
  const videoUrl = getOptionalString(env, 'REEL_VIDEO_URL');

  return {
    pageToken: getRequiredString(env, 'INSTAGRAM_PAGE_TOKEN'),
    igAccountId: getRequiredString(env, 'IG_BUSINESS_ACCOUNT_ID'),
    appId: getRequiredString(env, 'META_APP_ID'),
    appSecret: getRequiredString(env, 'META_APP_SECRET'),
    fbPageId: getRequiredString(env, 'FB_PAGE_ID'),
    videoUrl: videoUrl ? validateHttpUrl(videoUrl, 'REEL_VIDEO_URL') : undefined,
    caption: getOptionalString(env, 'REEL_CAPTION'),
    thumbOffset: getOptionalNumber(env, 'REEL_THUMB_OFFSET_MS', { integer: true, min: 0 }),
    shareToFeed: getOptionalBoolean(env, 'REEL_SHARE_TO_FEED'),
    coverUrl: getOptionalString(env, 'REEL_COVER_URL'),
  };
}
