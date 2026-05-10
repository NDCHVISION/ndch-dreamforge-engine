/**
 * NDCH Vision — Reel Generator
 * ElevenLabs TTS  →  Runway Gen-4  →  FFmpeg merge  →  GitHub Release
 *
 * Required env vars
 * ─────────────────
 *   ELEVENLABS_API_KEY   Your ElevenLabs API key
 *   RUNWAY_API_KEY       Your Runway ML API key
 *   GITHUB_TOKEN         Auto-injected in Actions (needs contents:write)
 *   REEL_SCRIPT          Voiceover text (spoken in your cloned voice)
 *   REEL_PROMPT          Visual prompt for Runway Gen-4
 *
 * Writes REEL_VIDEO_URL to $GITHUB_ENV so publish-reel.ts picks it up.
 *
 * Node ≥ 18 + ffmpeg on PATH required.
 */

import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { execSync }                                    from 'node:child_process';
import { tmpdir }                                      from 'node:os';
import { join }                                        from 'node:path';

// ── Env ───────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`✗  Missing env var: ${name}`); process.exit(1); }
  return v;
}

const ELEVENLABS_KEY = requireEnv('ELEVENLABS_API_KEY');
const RUNWAY_KEY     = requireEnv('RUNWAY_API_KEY');
const GITHUB_TOKEN   = requireEnv('GITHUB_TOKEN');
const SCRIPT         = requireEnv('REEL_SCRIPT');
const PROMPT         = requireEnv('REEL_PROMPT');

const VOICE_ID       = 'C9Uh5MFptuXa176UlaXE';   // NDCH Vision cloned voice
const REPO           = 'NDCHVISION/ndch-dreamforge-engine';
const TMP            = tmpdir();

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Step 1: ElevenLabs voiceover ──────────────────────────────────────────────

async function generateVoiceover(): Promise<string> {
  console.log('  [1/4] Generating voiceover via ElevenLabs…');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':   ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text:     SCRIPT,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);

  const audioPath = join(TMP, 'voiceover.mp3');
  writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));

  const dur = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`
  ).toString().trim();
  console.log(`         saved: ${audioPath}  (${parseFloat(dur).toFixed(1)}s)`);

  return audioPath;
}

// ── Step 2: Runway Gen-4 video ────────────────────────────────────────────────

async function generateVideo(audioDurationSecs: number): Promise<string> {
  console.log('  [2/4] Generating video via Runway Gen-4 Turbo…');

  // Runway accepts 5 or 10 seconds; pick whichever covers the audio
  const duration: 5 | 10 = audioDurationSecs <= 5 ? 5 : 10;

  const createRes = await fetch('https://api.runwayml.com/v1/text_to_video', {
    method:  'POST',
    headers: {
      'Authorization':   `Bearer ${RUNWAY_KEY}`,
      'Content-Type':    'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      promptText: PROMPT,
      model:      'gen4_turbo',
      ratio:      '720:1280',   // 9:16 — Instagram Reels portrait
      duration,
    }),
  });

  if (!createRes.ok) throw new Error(`Runway create ${createRes.status}: ${await createRes.text()}`);

  const { id } = await createRes.json() as { id: string };
  console.log(`         task id: ${id}`);

  // Poll up to 5 minutes
  const deadline = Date.now() + 300_000;
  let attempt    = 0;

  while (Date.now() < deadline) {
    await sleep(10_000);
    attempt++;

    const pollRes = await fetch(`https://api.runwayml.com/v1/tasks/${id}`, {
      headers: {
        'Authorization':    `Bearer ${RUNWAY_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
    });

    const task = await pollRes.json() as {
      status:   string;
      output?:  string[];
      failure?: string;
    };

    console.log(`         [${attempt}] ${task.status}`);

    if (task.status === 'SUCCEEDED') {
      const videoUrl  = task.output![0];
      const videoPath = join(TMP, 'runway.mp4');
      const dl        = await fetch(videoUrl);
      writeFileSync(videoPath, Buffer.from(await dl.arrayBuffer()));
      console.log(`         saved: ${videoPath}`);
      return videoPath;
    }

    if (task.status === 'FAILED') {
      throw new Error(`Runway task failed: ${task.failure ?? 'unknown reason'}`);
    }
  }

  throw new Error('Runway timed out after 5 minutes — try a shorter prompt or retry');
}

// ── Step 3: FFmpeg merge ──────────────────────────────────────────────────────

function mergeAudioVideo(audioPath: string, videoPath: string): string {
  console.log('  [3/4] Merging audio + video…');

  const outputPath = join(TMP, 'final.mp4');

  // -shortest trims to the shorter stream (audio wins when VO < video length)
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
    `-c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`,
    { stdio: 'inherit' }
  );

  console.log(`         merged: ${outputPath}`);
  return outputPath;
}

// ── Step 4: GitHub Release upload ─────────────────────────────────────────────

async function uploadToGitHubRelease(videoPath: string): Promise<string> {
  console.log('  [4/4] Uploading to GitHub Release…');

  const tag  = `reel-${Date.now()}`;
  const name = `Reel ${new Date().toISOString().slice(0, 10)}`;

  // Create release
  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases`,
    {
      method:  'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        tag_name:   tag,
        name,
        body:       `Auto-generated Instagram Reel — ${new Date().toUTCString()}`,
        draft:      false,
        prerelease: true,
      }),
    }
  );

  if (!releaseRes.ok) throw new Error(`GitHub release create ${releaseRes.status}: ${await releaseRes.text()}`);

  const release = await releaseRes.json() as { upload_url: string };

  // Upload video asset
  const uploadUrl  = release.upload_url.replace('{?name,label}', '?name=reel.mp4');
  const videoBuffer = readFileSync(videoPath);

  const uploadRes = await fetch(uploadUrl, {
    method:  'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Content-Type':  'video/mp4',
      'Accept':        'application/vnd.github.v3+json',
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) throw new Error(`GitHub upload ${uploadRes.status}: ${await uploadRes.text()}`);

  const asset = await uploadRes.json() as { browser_download_url: string };
  console.log(`         url: ${asset.browser_download_url}`);
  return asset.browser_download_url;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('NDCH Vision — Reel Generator');
console.log(`  voice  : ${VOICE_ID}`);
console.log(`  prompt : ${PROMPT.slice(0, 80)}…`);
console.log('');

const audioPath = await generateVoiceover();

const durationSecs = parseFloat(
  execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`
  ).toString().trim()
);

const videoPath = await generateVideo(durationSecs);
const finalPath = mergeAudioVideo(audioPath, videoPath);
const publicUrl = await uploadToGitHubRelease(finalPath);

// Expose to subsequent Actions steps
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `REEL_VIDEO_URL=${publicUrl}\n`);
}

console.log('');
console.log(`✓  Reel ready → ${publicUrl}`);
