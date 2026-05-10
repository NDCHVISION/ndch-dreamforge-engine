# NDCH Dreamforge Engine

Generate and publish motivational Instagram reels via:

- ElevenLabs (voiceover)
- Runway (video generation)
- FFmpeg (merge/post-processing)
- GitHub Releases (artifact hosting)
- Meta Graph API (Instagram publish)

## Local prerequisites

- Node.js 20+
- `ffmpeg` and `ffprobe` on PATH

## Install

```bash
npm ci
cp .env.example .env
```

Populate `.env` with the generation/publishing secrets and release settings you need for your run.

## Commands

```bash
# Type-check the TypeScript scripts
npm run typecheck

# Lint the project
npm run lint

# Run unit tests
npm test

# Format files
npm run format

# Generate reel assets (writes REEL_VIDEO_URL to GITHUB_ENV when present)
npm run generate

# Publish to Instagram using generated REEL_VIDEO_URL
npm run publish
```

## Required env vars

### Generation (`generate-reel.ts`)

- `ELEVENLABS_API_KEY`
- `RUNWAY_API_KEY`
- `GITHUB_TOKEN`
- `GITHUB_REPOSITORY` (or `REEL_RELEASE_REPO`)
- Input fallback: `REEL_SCRIPT`, `REEL_PROMPT` (or JSON via `ENGINE_CONFIG_PATH`, `REEL_SPEC_PATH`)

### Publish (`publish-reel.ts`)

- `INSTAGRAM_PAGE_TOKEN`
- `IG_BUSINESS_ACCOUNT_ID`
- `META_APP_ID`
- `META_APP_SECRET`
- `FB_PAGE_ID`
- `REEL_VIDEO_URL`

## Optional env vars

- `REEL_RELEASE_TAG`
- `REEL_RELEASE_NAME`
- `REEL_CAPTION`
- `REEL_MUSIC_PATH`
- `REEL_THUMB_OFFSET_MS`
- `REEL_SHARE_TO_FEED`
- `REEL_RUNWAY_CONCURRENCY` (1-4)

Use `.env.example` as the reference for the supported generation, release, and publish configuration.
