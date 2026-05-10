# NDCH Dreamforge Engine

Generate and publish motivational Instagram reels via:

- ElevenLabs (voiceover)
- Runway (video generation)
- FFmpeg (merge/post-processing)
- GitHub Releases (artifact hosting)
- Meta Graph API (Instagram publish)

## Local prerequisites

- Node.js 18+
- `ffmpeg` and `ffprobe` on PATH

## Commands

```bash
# Run unit tests
npx --yes tsx --test reel-plan.test.ts

# Generate reel assets (writes REEL_VIDEO_URL to GITHUB_ENV when present)
npx --yes tsx generate-reel.ts

# Publish to Instagram using generated REEL_VIDEO_URL
npx --yes tsx publish-reel.ts
```

## Required env vars

### Generation (`generate-reel.ts`)

- `ELEVENLABS_API_KEY`
- `RUNWAY_API_KEY`
- `GITHUB_TOKEN`
- Input fallback: `REEL_SCRIPT`, `REEL_PROMPT` (or JSON via `ENGINE_CONFIG_PATH`, `REEL_SPEC_PATH`)

### Publish (`publish-reel.ts`)

- `INSTAGRAM_PAGE_TOKEN`
- `IG_BUSINESS_ACCOUNT_ID`
- `META_APP_ID`
- `META_APP_SECRET`
- `FB_PAGE_ID`
- `REEL_VIDEO_URL`

## Optional env vars

- `REEL_CAPTION`
- `REEL_MUSIC_PATH`
- `REEL_THUMB_OFFSET_MS`
- `REEL_SHARE_TO_FEED`
- `REEL_RUNWAY_CONCURRENCY` (1-4)
