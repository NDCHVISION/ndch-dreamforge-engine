/**
 * NDCH Vision — Reel Generator
 * ElevenLabs TTS  →  Runway Gen-4  →  FFmpeg merge  →  GitHub Release
 *
 * Required env vars
 * ─────────────────
 *   ELEVENLABS_API_KEY   Your ElevenLabs API key
 *   RUNWAY_API_KEY       Your Runway ML API key
 *   GITHUB_TOKEN         Auto-injected in Actions (needs contents:write)
 *   REEL_SCRIPT          Voiceover text fallback when REEL_SPEC_PATH is absent
 *   REEL_PROMPT          Visual prompt fallback when JSON inputs do not resolve one
 *
 * Optional JSON inputs
 * ────────────────────
 *   ENGINE_CONFIG_PATH  Global engine config JSON with styles/defaults
 *   REEL_SPEC_PATH      Per-reel production brief/spec JSON
 *
 * Optional audio enhancement
 * ──────────────────────────
 *   REEL_MUSIC_PATH     Absolute path to an ambient music file (mp3/wav/aac).
 *                       If absent, the engine also checks assets/ambient-drone.mp3
 *                       relative to the repo root. Music is mixed at −18 dB with
 *                       a 1.5 s fade-in and 2.0 s fade-out, plus adaptive ducking
 *                       under narration for clearer voice-forward playback. Omit
 *                       to skip music.
 *
 * Writes REEL_VIDEO_URL to $GITHUB_ENV so publish-reel.ts picks it up.
 *
 * Node ≥ 18 + ffmpeg on PATH required.
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync, copyFileSync } from 'node:fs';
import { execSync }                                                 from 'node:child_process';
import { randomUUID }                                               from 'node:crypto';
import { tmpdir }                                                   from 'node:os';
import { join, resolve }                                            from 'node:path';
import { fileURLToPath }                                            from 'node:url';
import { type ResolvedProductionPlan } from './reel-plan.ts';
import { requestBuffer, requestJson, requestText } from './http-client.ts';
import { ENGINE_DEFAULTS } from './engine-defaults.ts';
import { loadGenerateRuntimeConfig, type GenerateRuntimeConfig } from './config/env.ts';
import {
  type ReelScenePlan,
  type SceneAllocationEntry,
  buildSceneTimeline,
  limitWords,
  normalizeWhitespace,
  planNarrationScenes,
} from './lib/scene-planning.ts';
import {
  type SubtitleCue,
  buildFallbackSubtitleCues,
} from './lib/subtitles.ts';
import {
  buildAdaptiveMusicMixFilter,
  resolveMusicTrackPath,
} from './lib/audio-mixing.ts';
import {
  getRunwayPollDelayMs,
  getRunwayRetryDelayMs,   checkRunwayCreditBalance,   assertSufficientRunwayCredits,   estimateRunwayCostCredits,
} from './lib/runway-resilience.ts';

const DEFAULT_VOICE_ID           = ENGINE_DEFAULTS.defaultVoiceId;
const DEFAULT_ELEVENLABS_MODEL   = ENGINE_DEFAULTS.defaultModelId;
const DEFAULT_OUTPUT_FORMAT      = 'mp3_44100_192';
const TMP                        = tmpdir();
const MAX_REEL_SECS              = ENGINE_DEFAULTS.maxDurationSeconds;
const RUNWAY_TIMEOUT_MS          = 300_000;
const RUNWAY_MAX_TASK_ATTEMPTS   = 3;
const MUSIC_ASSET_RELATIVE_PATH  = 'assets/ambient-drone.mp3';
const DEFAULT_HTTP_TIMEOUT_MS    = 45_000;
const MANAGED_RELEASE_TAG        = 'reel-latest';
const MANAGED_RELEASE_NAME       = 'NDCH Dreamforge Latest Reel';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let runtimeConfig: GenerateRuntimeConfig | undefined;

function getConfig(): GenerateRuntimeConfig {
  runtimeConfig ??= loadGenerateRuntimeConfig(process.env, {
      defaultVoiceId: DEFAULT_VOICE_ID,
      defaultModelId: DEFAULT_ELEVENLABS_MODEL,
      releaseTag: MANAGED_RELEASE_TAG,
      releaseName: MANAGED_RELEASE_NAME,
      runwayConcurrency: 2,
    });
  return runtimeConfig;
}

function getMediaDuration(path: string): number {
  try {
    const duration = parseFloat(
      execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`)
        .toString()
        .trim()
    );
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`invalid ffprobe duration: ${duration}`);
    }
    return duration;
  } catch (err) {
    throw new Error(`Failed to read media duration for ${path}: ${(err as Error).message}`);
  }
}

// ── Audio post-processing ─────────────────────────────────────────────────────

/**
 * Applies cinematic audio post-processing to the raw voiceover:
 *   • 80 Hz low-shelf warm boost (+3 dB)    — adds body and gravitas
 *   • 3 kHz presence boost (+2 dB)           — cuts through ambient music
 *   • Loudness normalisation to −14 LUFS     — streaming-safe level (Instagram spec)
 *
 * Uses a single-pass loudnorm filter which is accurate to ±1 LU for speech.
 */
function processAudio(inputPath: string): string {
  console.log('         post-processing audio (EQ + LUFS normalisation)…');
  const outputPath = join(TMP, 'voiceover-processed.mp3');

  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" ` +
      `-af "equalizer=f=80:width_type=o:width=2:g=3,` +
      `equalizer=f=3000:width_type=o:width=2:g=2,` +
      `loudnorm=I=-14:TP=-1.5:LRA=11" ` +
      `-ar 44100 -b:a 192k "${outputPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    throw new Error(`Audio post-processing failed: ${(err as Error).message}`);
  }

  console.log(`         processed: ${outputPath}`);
  return outputPath;
}

/**
 * Optionally mixes a dark-ambient music track under the processed voiceover.
 *
 * Music source resolution order:
 *   1. REEL_MUSIC_PATH env var (absolute path)
 *   2. assets/ambient-drone.mp3 in the repo root
 *   3. Not found → skip gracefully, return voicePath unchanged
 *
 * Mix settings (per reel_001 spec):
 *   • Volume: −18 dB (music sits well beneath the voice)
 *   • Fade-in: 1.5 s
 *   • Fade-out: 2.0 s (timed to end of narration)
 *   • Music loops indefinitely to cover any narration length
 *   • Sidechain ducking keeps narration dominant without hard pumping
 */
function mixMusicUnderVoice(voicePath: string, audioDurationSecs: number): string {
  const { musicPath: musicEnvPath } = getConfig();
  const musicAssetPath = join(resolve('.'), MUSIC_ASSET_RELATIVE_PATH);
  const musicPath = resolveMusicTrackPath(musicEnvPath, musicAssetPath, existsSync(musicAssetPath));

  if (!musicPath) {
    console.log(
      '         no music track found — skipping music layer ' +
      '(set REEL_MUSIC_PATH or add assets/ambient-drone.mp3 to the repo)'
    );
    return voicePath;
  }

  console.log(`         mixing ambient music: ${musicPath}`);
  const mixedPath = join(TMP, 'voiceover-mixed.mp3');
  const filterGraph = buildAdaptiveMusicMixFilter(audioDurationSecs);

  try {
    execSync(
      `ffmpeg -y ` +
      `-stream_loop -1 -i "${musicPath}" ` +
      `-i "${voicePath}" ` +
      `-filter_complex "${filterGraph}" ` +
      `-map "[out]" -ar 44100 -b:a 192k "${mixedPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    throw new Error(`Music mixing failed: ${(err as Error).message}`);
  }

  console.log(`         mixed: ${mixedPath}`);
  return mixedPath;
}

// ── Step 1: ElevenLabs voiceover ──────────────────────────────────────────────

async function generateVoiceover(): Promise<string> {
  console.log('  [1/4] Generating voiceover via ElevenLabs…');
  const { elevenLabsKey, plan } = getConfig();
  const voiceId      = plan.elevenLabs.voiceId ?? DEFAULT_VOICE_ID;
  const outputFormat = (plan.elevenLabs as Record<string, unknown>).outputFormat as string | undefined
                       ?? DEFAULT_OUTPUT_FORMAT;

  console.log(`         model : ${plan.elevenLabs.modelId}`);
  console.log(`         voice : ${voiceId}`);
  console.log(`         format: ${outputFormat}`);

  // ElevenLabs API:
  //   • voice_settings  → stability, similarity_boost, style, use_speaker_boost
  //   • speed           → top-level body field (NOT inside voice_settings)
  // The reel spec stores speed inside elevenLabs_config.voice_settings for
  // convenience; we extract it here to place it correctly in the request.
  const rawSettings  = (plan.elevenLabs.voiceSettings ?? {}) as Record<string, unknown>;
  const { speed, ...pureVoiceSettings } = rawSettings;

  if (speed !== undefined) {
    console.log(`         speed : ${speed}`);
  }

  const audioBuffer = await requestBuffer(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: plan.script,
        model_id: plan.elevenLabs.modelId,
        ...(Object.keys(pureVoiceSettings).length > 0 ? { voice_settings: pureVoiceSettings } : {}),
        ...(speed !== undefined ? { speed } : {}),
      }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      maxRetries: 3,
    }
  );

  // ── 1a: Save raw TTS output ────────────────────────────────────────────────
  const rawAudioPath = join(TMP, 'voiceover-raw.mp3');
  writeFileSync(rawAudioPath, audioBuffer);
  const rawDuration = getMediaDuration(rawAudioPath);
  console.log(`         raw saved: ${rawAudioPath}  (${rawDuration.toFixed(1)}s)`);

  // ── 1b: Audio post-processing — EQ + LUFS normalisation ───────────────────
  const processedPath = processAudio(rawAudioPath);

  // ── 1c: Ambient music layer (optional) ────────────────────────────────────
  const finalAudioSource = mixMusicUnderVoice(processedPath, rawDuration);

  // Normalise to the canonical output filename the rest of the pipeline expects.
  const audioPath = join(TMP, 'voiceover.mp3');
  copyFileSync(finalAudioSource, audioPath);

  const finalDuration = getMediaDuration(audioPath);
  console.log(`         final : ${audioPath}  (${finalDuration.toFixed(1)}s)`);

  return audioPath;
}

// ── Step 2: Runway Gen-4 video ────────────────────────────────────────────────

/** Formats seconds as M:SS for display. */
function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function generateRunwayClip(scene: ReelScenePlan, totalClips: number): Promise<string> {
  const { runwayKey } = getConfig();
  const clipLabel = `clip ${scene.clipIndex + 1}/${totalClips}`;
  let lastReason = `Runway task timed out after ${RUNWAY_TIMEOUT_MS / 1000}s`;

  for (let taskAttempt = 1; taskAttempt <= RUNWAY_MAX_TASK_ATTEMPTS; taskAttempt++) {
    console.log(
      `         ${clipLabel}: requesting ${scene.clipDuration}s for "${limitWords(scene.narrationChunk, 14)}"` +
      ` (attempt ${taskAttempt}/${RUNWAY_MAX_TASK_ATTEMPTS})`
    );
    const { id } = await requestJson<{ id: string }>('https://api.dev.runwayml.com/v1/text_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${runwayKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify({
        promptText: scene.promptText,
        model: 'gen4.5',
        ratio: '720:1280',
        duration: scene.clipDuration,
      }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      maxRetries: 3,
    });
    console.log(`         ${clipLabel}: task id ${id}`);

    const deadline = Date.now() + RUNWAY_TIMEOUT_MS;
    let pollAttempt = 0;
    let previousStatus: string | undefined;

    while (Date.now() < deadline) {
      await sleep(getRunwayPollDelayMs(previousStatus));
      pollAttempt++;

      const task = await requestJson<{
        status:   string;
        output?:  string[];
        failure?: string;
      }>(`https://api.dev.runwayml.com/v1/tasks/${id}`, {
        headers: {
          'Authorization': `Bearer ${runwayKey}`,
          'X-Runway-Version': '2024-11-06',
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        maxRetries: 3,
      });

      previousStatus = task.status;
      console.log(`         ${clipLabel} [${pollAttempt}] ${task.status}`);

      if (task.status === 'SUCCEEDED') {
        const videoUrl = task.output?.[0];
        if (!videoUrl) throw new Error(
          `Runway task ${id} succeeded but returned no output URL — this may indicate an API response change or incomplete generation`
        );

        const videoPath = join(TMP, `runway-${String(scene.clipIndex + 1).padStart(2, '0')}.mp4`);
        const clipBuffer = await requestBuffer(videoUrl, {
          timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
          maxRetries: 3,
        });
        writeFileSync(videoPath, clipBuffer);
        console.log(`         ${clipLabel}: saved ${videoPath}`);
        return videoPath;
      }

      if (task.status === 'FAILED' || task.status === 'CANCELLED') {
        lastReason = task.failure ?? `Runway task ${id} ended with status ${task.status}`;
        break;
      }
    }

    if (Date.now() >= deadline) {
      lastReason = `Runway task ${id} remained ${previousStatus ?? 'RUNNING'} after ${RUNWAY_TIMEOUT_MS / 1000}s`;
    }

    if (taskAttempt < RUNWAY_MAX_TASK_ATTEMPTS) {
      const retryDelayMs = getRunwayRetryDelayMs(taskAttempt);
      console.log(`         ${clipLabel}: retrying after ${Math.round(retryDelayMs / 1000)}s (${lastReason})`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error(
    `Runway clip ${scene.clipIndex + 1}/${totalClips} failed after ${RUNWAY_MAX_TASK_ATTEMPTS} attempts: ${lastReason}`
  );
}

function stitchVideoClips(clipPaths: string[]): string {
  if (clipPaths.length === 0) throw new Error('No Runway clips were generated for stitching');

  const uniqueId = randomUUID();
  const listPath = join(TMP, `runway-concat-${uniqueId}.txt`);
  const stitchedPath = join(TMP, `runway-stitched-${uniqueId}.mp4`);
  const resolvedTmpPrefix = `${resolve(TMP)}/`;

  const listFile = clipPaths.map(path => {
    const resolvedPath = resolve(path);
    const safePathPattern = /^[A-Za-z0-9._/:-]+$/;
    if (
      /[\r\n]/.test(resolvedPath) ||
      !resolvedPath.startsWith(resolvedTmpPrefix) ||
      !resolvedPath.endsWith('.mp4') ||
      !safePathPattern.test(resolvedPath)
    ) {
      throw new Error(`Unsafe clip path for ffmpeg concat list: ${path}`);
    }
    return `file '${resolvedPath}'`;
  }).join('\n');

  writeFileSync(listPath, `${listFile}\n`);
  console.log('         stitching clips with ffmpeg concat…');

  try {
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${stitchedPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    throw new Error(`Failed to stitch Runway clips with ffmpeg: ${(err as Error).message}`);
  }

  console.log(`         stitched: ${stitchedPath}`);
  return stitchedPath;
}

async function generateRunwayClipsBounded(scenePlan: ReelScenePlan[]): Promise<string[]> {
  const { runwayConcurrency: concurrency } = getConfig();
  const clipPaths = new Array<string>(scenePlan.length);
  let nextIndex = 0;

  console.log(`         runway concurrency: ${concurrency}`);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= scenePlan.length) return;
      const scene = scenePlan[currentIndex];
      clipPaths[currentIndex] = await generateRunwayClip(scene, scenePlan.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, scenePlan.length) },
    () => worker()
  );
  await Promise.all(workers);

  return clipPaths;
}

async function generateVideo(audioDurationSecs: number): Promise<{ videoPath: string; sceneTimeline: SceneAllocationEntry[] }> {
  console.log('  [2/4] Generating video via Runway Gen-4 Turbo…');
  const { plan } = getConfig();
  if (plan.targetDurationSeconds !== undefined && plan.targetDurationSeconds < audioDurationSecs) {
    console.log(
      `         target ${plan.targetDurationSeconds}s is shorter than narration ${audioDurationSecs.toFixed(1)}s; preserving full narration length`
    );
  }

  const scenePlan = planNarrationScenes(plan.script, plan.prompt, audioDurationSecs, {
    targetDurationSecs: plan.targetDurationSeconds,
    narrationSegments: plan.narrationSegments,
  });
  const sceneTimeline = buildSceneTimeline(scenePlan, plan.narrationSegments);
  const durations = scenePlan.map(scene => scene.clipDuration);
  const plannedVisualSecs = durations.reduce((sum, d) => sum + d, 0);
  console.log(
    `         narration ${audioDurationSecs.toFixed(1)}s, target ${plan.targetDurationSeconds ?? 'auto'}s, planned visual target up to ${MAX_REEL_SECS}s, plan: ${durations.join(' + ')} = ${plannedVisualSecs}s`
  );

  // Emit resolved allocation plan — one line per clip with per-segment detail.
  sceneTimeline.forEach(entry => {
    const tsRange = entry.timestampStartSeconds !== undefined && entry.timestampEndSeconds !== undefined
      ? ` | ${formatTimestamp(entry.timestampStartSeconds)}–${formatTimestamp(entry.timestampEndSeconds)}`
      : '';
    const intendedStr = entry.intendedNarrationDurationSecs !== undefined
      ? `, intended ${entry.intendedNarrationDurationSecs.toFixed(1)}s`
      : '';
    console.log(
      `         scene ${entry.clipIndex + 1}/${sceneTimeline.length}: ${entry.clipDuration}s clip${tsRange} — narration ~${entry.estimatedNarrationSecs.toFixed(1)}s${intendedStr}`
    );
    if (entry.coveredSegments.length > 0) {
      const segSummary = entry.coveredSegments.map(seg => {
        const segTs = seg.timestampStartSeconds !== undefined && seg.timestampEndSeconds !== undefined
          ? ` (${formatTimestamp(seg.timestampStartSeconds)}–${formatTimestamp(seg.timestampEndSeconds)}${seg.intendedDurationSecs !== undefined ? `, ${seg.intendedDurationSecs.toFixed(1)}s` : ''})`
          : '';
        return `[${seg.segmentIndex}] "${limitWords(seg.text, 8)}"${segTs}`;
      }).join(' · ');
      console.log(`           covers   : ${segSummary}`);
    }
    console.log(`           narration: ${entry.narrationText}`);
    console.log(`           prompt   : ${entry.promptText}`);
  });

  const clipPaths = await generateRunwayClipsBounded(scenePlan);

  const stitchedPath = stitchVideoClips(clipPaths);
  const stitchedDuration = getMediaDuration(stitchedPath);
  console.log(`         stitched duration: ${stitchedDuration.toFixed(1)}s`);
  return { videoPath: stitchedPath, sceneTimeline };
}

// ── Step 3: FFmpeg merge ──────────────────────────────────────────────────────

function mergeAudioVideo(audioPath: string, videoPath: string): string {
  console.log('  [3/4] Merging audio + video…');

  const outputPath = join(TMP, 'final.mp4');

  // -shortest trims output to whichever stream ends first for clean overlap.
  try {
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    throw new Error(`Failed to merge audio/video with ffmpeg: ${(err as Error).message}`);
  }

  const finalDuration = getMediaDuration(outputPath);
  console.log(`         merged: ${outputPath} (${finalDuration.toFixed(1)}s)`);
  return outputPath;
}

// ── Step 4: GitHub Release upload ─────────────────────────────────────────────

interface GitHubReleaseAsset {
  id: number;
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  id: number;
  upload_url: string;
  assets: GitHubReleaseAsset[];
}

function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github.v3+json',
  };
}

async function uploadReleaseAsset(
  release: GitHubRelease,
  token: string,
  repo: string,
  assetName: string,
  contentType: string,
  content: Buffer
): Promise<string> {
  const existing = release.assets.find(asset => asset.name === assetName);
  if (existing) {
    await requestText(
      `https://api.github.com/repos/${repo}/releases/assets/${existing.id}`,
      {
        method: 'DELETE',
        headers: githubHeaders(token),
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        maxRetries: 3,
      }
    );
  }

  const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(assetName)}`);
  const uploaded = await requestJson<GitHubReleaseAsset>(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': contentType,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: new Uint8Array(content),
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    maxRetries: 3,
  });
  return uploaded.browser_download_url;
}

async function getOrCreateManagedRelease(
  token: string,
  repo: string,
  releaseTag: string,
  releaseName: string
): Promise<GitHubRelease> {
  const releases = await requestJson<Array<GitHubRelease & { tag_name: string }>>(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
    {
      headers: githubHeaders(token),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      maxRetries: 3,
    }
  );

  const existing = releases.find(release => release.tag_name === releaseTag);
  if (existing) return existing;

  return requestJson<GitHubRelease>(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      tag_name: releaseTag,
      name: releaseName,
      body: 'Managed prerelease for latest NDCH Dreamforge artifacts',
      draft: false,
      prerelease: true,
    }),
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    maxRetries: 3,
  });
}

async function uploadToGitHubRelease(videoPath: string, subtitlePath?: string): Promise<{ videoUrl: string; subtitleUrl?: string }> {
  console.log('  [4/4] Uploading to GitHub Release…');
  const { githubToken, releaseRepo, releaseTag, releaseName } = getConfig();

  const release = await getOrCreateManagedRelease(githubToken, releaseRepo, releaseTag, releaseName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const videoUrl = await uploadReleaseAsset(
    release,
    githubToken,
    releaseRepo,
    `reel-${timestamp}.mp4`,
    'video/mp4',
    readFileSync(videoPath)
  );

  let subtitleUrl: string | undefined;
  if (subtitlePath) {
    subtitleUrl = await uploadReleaseAsset(
      release,
      githubToken,
      releaseRepo,
      `reel-${timestamp}.srt`,
      'application/x-subrip',
      readFileSync(subtitlePath)
    );
  }

  console.log(`         url: ${videoUrl}`);
  if (subtitleUrl) console.log(`         subtitles: ${subtitleUrl}`);
  return { videoUrl, subtitleUrl };
}

function formatSrtTimestamp(seconds: number, contextLabel: string): string {
  if (seconds < 0) {
    throw new Error(`Subtitle timestamp cannot be negative (${contextLabel}): ${seconds}`);
  }
  const totalMillis = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMillis / 3_600_000);
  const mins = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function buildSubtitleCues(plan: ResolvedProductionPlan, sceneTimeline: SceneAllocationEntry[]): SubtitleCue[] {
  const cuesFromSegments = plan.narrationSegments
    .map(segment => ({
      startSeconds: segment.timestampStartSeconds,
      endSeconds: segment.timestampEndSeconds,
      text: normalizeWhitespace(segment.text),
    }))
    .filter((cue): cue is SubtitleCue =>
      cue.startSeconds !== undefined &&
      cue.endSeconds !== undefined &&
      cue.endSeconds > cue.startSeconds &&
      cue.text.length > 0
    );
  if (cuesFromSegments.length > 0) return cuesFromSegments;

  return buildFallbackSubtitleCues(sceneTimeline);
}

function writeSubtitleSidecar(plan: ResolvedProductionPlan, sceneTimeline: SceneAllocationEntry[]): string | undefined {
  if (!plan.subtitles || typeof plan.subtitles !== 'object') return undefined;
  if ((plan.subtitles as Record<string, unknown>).enabled === false) return undefined;

  const cues = buildSubtitleCues(plan, sceneTimeline);
  if (cues.length === 0) return undefined;

  const subtitlePath = join(TMP, `reel-subtitles-${Date.now()}.srt`);
  const srt = cues
    .map((cue, index) => (
      `${index + 1}\n${formatSrtTimestamp(cue.startSeconds, `cue ${index + 1} start`)} --> ${formatSrtTimestamp(cue.endSeconds, `cue ${index + 1} end`)}\n${cue.text}\n`
    ))
    .join('\n');
  writeFileSync(subtitlePath, srt);
  console.log(`  subtitles     : ${subtitlePath}`);
  return subtitlePath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { plan, releaseRepo, releaseTag, releaseName, runwayConcurrency, musicPath } = getConfig();
  console.log('NDCH Vision — Reel Generator');
  console.log(`  engine config : ${plan.engineConfigPath ?? '(env only)'}`);
  console.log(`  reel spec     : ${plan.reelSpecPath ?? '(env only)'}`);
  console.log(`  release repo  : ${releaseRepo}`);
  console.log(`  release tag   : ${releaseTag}`);
  console.log(`  release name  : ${releaseName}`);
  console.log(`  runway conc.  : ${runwayConcurrency}`);
  console.log(`  music path    : ${musicPath ?? '(auto-detect asset or skip)'}`);
  console.log(`  voice         : ${plan.elevenLabs.voiceId ?? DEFAULT_VOICE_ID}`);
  console.log(`  model         : ${plan.elevenLabs.modelId}`);
  console.log(`  style         : ${plan.selectedStyleId ?? '(none)'}`);
  console.log(`  target secs   : ${plan.targetDurationSeconds ?? '(audio-driven)'}`);
  console.log(`  segments      : ${plan.narrationSegments.length || '(auto-split from script)'}`);
  console.log(`  prompt        : ${plan.prompt.slice(0, 80)}…`);
  if (plan.instagram.caption) {
    console.log(`  caption       : ${plan.instagram.caption.slice(0, 80)}…`);
  }
  console.log('');

  const audioPath = await generateVoiceover();
  const durationSecs = getMediaDuration(audioPath);

  const { videoPath, sceneTimeline } = await generateVideo(durationSecs);
  const finalPath = mergeAudioVideo(audioPath, videoPath);
  const subtitlePath = writeSubtitleSidecar(plan, sceneTimeline);
  const { videoUrl: publicUrl, subtitleUrl } = await uploadToGitHubRelease(finalPath, subtitlePath);

  // Write resolved plan artifact (including scene timeline) after generation completes.
  const resolvedPlanPath = join(TMP, `resolved-plan-${Date.now()}.json`);
  writeFileSync(resolvedPlanPath, JSON.stringify({
    engineConfigPath: plan.engineConfigPath,
    reelSpecPath: plan.reelSpecPath,
    concept: plan.concept,
    selectedStyleId: plan.selectedStyleId,
    script: plan.script,
    narrationSegments: plan.narrationSegments,
    prompt: plan.prompt,
    targetDurationSeconds: plan.targetDurationSeconds,
    elevenLabs: plan.elevenLabs,
    instagram: plan.instagram,
     subtitles: plan.subtitles,
     subtitlePath,
     subtitleUrl,
     sceneTimeline,
   }, null, 2));
  console.log(`  resolved plan : ${resolvedPlanPath}`);

  // Expose to subsequent Actions steps
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `REEL_VIDEO_URL=${publicUrl}\n`);
    appendFileSync(process.env.GITHUB_ENV, `REEL_RESOLVED_PLAN_PATH=${resolvedPlanPath}\n`);
    if (subtitlePath) {
      appendFileSync(process.env.GITHUB_ENV, `REEL_SUBTITLE_PATH=${subtitlePath}\n`);
    }
    if (subtitleUrl) {
      appendFileSync(process.env.GITHUB_ENV, `REEL_SUBTITLE_URL=${subtitleUrl}\n`);
    }
    if (plan.instagram.caption) {
      const captionEnvDelimiter = `EOF_REEL_CAPTION_${randomUUID().slice(0, 8)}`;
      appendFileSync(process.env.GITHUB_ENV, `REEL_CAPTION<<${captionEnvDelimiter}\n${plan.instagram.caption}\n${captionEnvDelimiter}\n`);
    }
    if (plan.instagram.coverFrameOffsetMs !== undefined) {
      appendFileSync(process.env.GITHUB_ENV, `REEL_THUMB_OFFSET_MS=${plan.instagram.coverFrameOffsetMs}\n`);
    }
    if (plan.instagram.shareToFeed !== undefined) {
      appendFileSync(process.env.GITHUB_ENV, `REEL_SHARE_TO_FEED=${plan.instagram.shareToFeed}\n`);
    }
  }

  console.log('');
  console.log(`✓  Reel ready → ${publicUrl}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(err => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error('✗  Reel generation failed.');
    console.error(`   Reason: ${reason}`);
    console.error('   See logs above for the failing step.');
    process.exit(1);
  });
}
