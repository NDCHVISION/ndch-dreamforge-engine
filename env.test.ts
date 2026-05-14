import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getOptionalBoolean,
  loadGenerateRuntimeConfig,
  loadPublishRuntimeConfig,
} from './config/env.ts';
import {
  getRunwayPollDelayMs,
  getRunwayRetryDelayMs,
} from './lib/runway-resilience.ts';

const DEFAULTS = {
  defaultVoiceId: 'voice-default',
  defaultModelId: 'model-default',
  releaseTag: 'reel-latest',
  releaseName: 'NDCH Dreamforge Latest Reel',
  runwayConcurrency: 2,
};

test('loadGenerateRuntimeConfig loads a valid generate config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ndch-env-generate-'));

  try {
    const musicPath = join(tempDir, 'ambient.mp3');
    writeFileSync(musicPath, 'not-real-audio');

    const config = loadGenerateRuntimeConfig(
      {
        ELEVENLABS_API_KEY: 'eleven',
        RUNWAY_API_KEY: 'runway',
        GITHUB_TOKEN: 'github',
        REEL_RELEASE_REPO: 'NDCHVISION/NDCH-DREAMFORGE-ENGINE',
        REEL_RELEASE_TAG: 'reel-custom',
        REEL_RELEASE_NAME: 'Custom Release',
        REEL_RUNWAY_CONCURRENCY: '3',
        REEL_MUSIC_PATH: musicPath,
        REEL_SCRIPT: 'Move with patience and power.',
        REEL_PROMPT: 'A cinematic river at dawn.',
      },
      DEFAULTS
    );

    assert.equal(config.elevenLabsKey, 'eleven');
    assert.equal(config.runwayKey, 'runway');
    assert.equal(config.githubToken, 'github');
    assert.equal(config.releaseRepo, 'NDCHVISION/NDCH-DREAMFORGE-ENGINE');
    assert.equal(config.releaseTag, 'reel-custom');
    assert.equal(config.releaseName, 'Custom Release');
    assert.equal(config.runwayConcurrency, 3);
    assert.equal(config.musicPath, musicPath);
    assert.equal(config.plan.script, 'Move with patience and power.');
    assert.equal(config.plan.prompt, 'A cinematic river at dawn.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadGenerateRuntimeConfig falls back from REEL_RELEASE_REPO to GITHUB_REPOSITORY', () => {
  const config = loadGenerateRuntimeConfig(
    {
      ELEVENLABS_API_KEY: 'eleven',
      RUNWAY_API_KEY: 'runway',
      GITHUB_TOKEN: 'github',
      GITHUB_REPOSITORY: 'NDCHVISION/NDCH-DREAMFORGE-ENGINE',
      REEL_SCRIPT: 'Move with patience and power.',
      REEL_PROMPT: 'A cinematic river at dawn.',
    },
    DEFAULTS
  );

  assert.equal(config.releaseRepo, 'NDCHVISION/NDCH-DREAMFORGE-ENGINE');
});

test('loadGenerateRuntimeConfig rejects an invalid repository slug', () => {
  assert.throws(
    () => loadGenerateRuntimeConfig(
      {
        ELEVENLABS_API_KEY: 'eleven',
        RUNWAY_API_KEY: 'runway',
        GITHUB_TOKEN: 'github',
        REEL_RELEASE_REPO: 'not-a-slug',
        GITHUB_REPOSITORY: 'NDCHVISION/NDCH-DREAMFORGE-ENGINE',
        REEL_SCRIPT: 'Move with patience and power.',
        REEL_PROMPT: 'A cinematic river at dawn.',
      },
      DEFAULTS
    ),
    /Invalid repository slug/
  );
});

test('loadGenerateRuntimeConfig rejects invalid runway concurrency', () => {
  assert.throws(
    () => loadGenerateRuntimeConfig(
      {
        ELEVENLABS_API_KEY: 'eleven',
        RUNWAY_API_KEY: 'runway',
        GITHUB_TOKEN: 'github',
        GITHUB_REPOSITORY: 'NDCHVISION/NDCH-DREAMFORGE-ENGINE',
        REEL_RUNWAY_CONCURRENCY: '5',
        REEL_SCRIPT: 'Move with patience and power.',
        REEL_PROMPT: 'A cinematic river at dawn.',
      },
      DEFAULTS
    ),
    /REEL_RUNWAY_CONCURRENCY/
  );
});

test('loadPublishRuntimeConfig loads a valid publish config', () => {
  const config = loadPublishRuntimeConfig({
    INSTAGRAM_PAGE_TOKEN: 'page-token',
    IG_BUSINESS_ACCOUNT_ID: 'ig-account',
    META_APP_ID: 'meta-app',
    META_APP_SECRET: 'meta-secret',
    FB_PAGE_ID: 'fb-page',
    REEL_VIDEO_URL: 'https://example.com/reel.mp4',
    REEL_CAPTION: 'Keep flowing.',
    REEL_THUMB_OFFSET_MS: '3000',
    REEL_SHARE_TO_FEED: 'false',
  });

  assert.equal(config.pageToken, 'page-token');
  assert.equal(config.igAccountId, 'ig-account');
  assert.equal(config.appId, 'meta-app');
  assert.equal(config.appSecret, 'meta-secret');
  assert.equal(config.fbPageId, 'fb-page');
  assert.equal(config.videoUrl, 'https://example.com/reel.mp4');
  assert.equal(config.caption, 'Keep flowing.');
  assert.equal(config.thumbOffset, 3000);
  assert.equal(config.shareToFeed, false);
});

test('loadPublishRuntimeConfig rejects an invalid publish video URL', () => {
  assert.throws(
    () => loadPublishRuntimeConfig({
      INSTAGRAM_PAGE_TOKEN: 'page-token',
      IG_BUSINESS_ACCOUNT_ID: 'ig-account',
      META_APP_ID: 'meta-app',
      META_APP_SECRET: 'meta-secret',
      FB_PAGE_ID: 'fb-page',
      REEL_VIDEO_URL: 'ftp://example.com/reel.mp4',
    }),
    /REEL_VIDEO_URL/
  );
});

test('getOptionalBoolean rejects invalid boolean values', () => {
  assert.throws(
    () => getOptionalBoolean({ REEL_SHARE_TO_FEED: 'yes' }, 'REEL_SHARE_TO_FEED'),
    /Invalid boolean env var REEL_SHARE_TO_FEED: yes/
  );
});

test('getRunwayPollDelayMs uses a longer wait when task is throttled', () => {
  assert.equal(getRunwayPollDelayMs('RUNNING'), 10_000);
  assert.equal(getRunwayPollDelayMs('THROTTLED'), 45_000);
  assert.equal(getRunwayPollDelayMs('THROTTLED'), 45_000);
});

test('getRunwayRetryDelayMs applies capped exponential backoff', () => {
  assert.equal(getRunwayRetryDelayMs(1), 15_000);
  assert.equal(getRunwayRetryDelayMs(2), 30_000);
  assert.equal(getRunwayRetryDelayMs(3), 60_000);
  assert.equal(getRunwayRetryDelayMs(4), 60_000);
});
