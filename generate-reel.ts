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
 *                       a 1.5 s fade-in and 2.0 s fade-out. Omit to skip music.
 *
 * Writes REEL_VIDEO_URL to $GITHUB_ENV so publish-reel.ts picks it up.
 *
 * Node ≥ 18 + ffmpeg on PATH required.
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { execSync }                                                 from 'node:child_process';
import { randomUUID }                                               from 'node:crypto';
import { tmpdir }                                                   from 'node:os';
import { join, resolve }                                            from 'node:path';
import { fileURLToPath }                                            from 'node:url';
import { resolveProductionPlan, type ResolvedNarrationSegment, type ResolvedProductionPlan } from './reel-plan.ts';

// ── Env ───────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`✗  Missing env var: ${name}`); process.exit(1); }
  return v;
}

interface RuntimeConfig {
  elevenLabsKey: string;
  runwayKey: string;
  githubToken: string;
  plan: ResolvedProductionPlan;
}

const DEFAULT_VOICE_ID           = 'C9Uh5MFptuXa176UlaXE';   // NDCH Vision cloned voice
const DEFAULT_ELEVENLABS_MODEL   = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT      = 'mp3_44100_192';
const REPO                       = 'NDCHVISION/ndch-dreamforge-engine';
const TMP                        = tmpdir();
const MAX_REEL_SECS              = 45;
const RUNWAY_TIMEOUT_MS          = 300_000;
const MUSIC_ASSET_RELATIVE_PATH  = 'assets/ambient-drone.mp3';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let runtimeConfig: RuntimeConfig | undefined;

function getConfig(): RuntimeConfig {
  runtimeConfig ??= {
    elevenLabsKey: requireEnv('ELEVENLABS_API_KEY'),
    runwayKey: requireEnv('RUNWAY_API_KEY'),
    githubToken: requireEnv('GITHUB_TOKEN'),
    plan: resolveProductionPlan(process.env, {
      defaultVoiceId: DEFAULT_VOICE_ID,
      defaultModelId: DEFAULT_ELEVENLABS_MODEL,
    }),
  };
  return runtimeConfig;
}

export interface ReelScenePlan {
  clipIndex: number;
  clipDuration: 5 | 10;
  estimatedNarrationSecs: number;
  narrationChunk: string;
  promptText: string;
  /** Indices into the original narrationSegments array that this clip covers. */
  coveredSegmentIndices: number[];
  /** Timestamp of the first covered segment's start (seconds). */
  timestampStartSeconds?: number;
  /** Timestamp of the last covered segment's end (seconds). */
  timestampEndSeconds?: number;
  /** Narration duration derived from timestamps (end − start). Undefined when timestamps are absent. */
  intendedNarrationDurationSecs?: number;
}

/**
 * Per-clip entry in the resolved scene timeline / allocation plan.
 * Suitable for logging, artifact output, and future post-trim support.
 */
export interface SceneAllocationEntry {
  clipIndex: number;
  clipDuration: 5 | 10;
  narrationText: string;
  timestampStartSeconds?: number;
  timestampEndSeconds?: number;
  /** Total narration duration intended from timestamps. Undefined when timestamps are absent. */
  intendedNarrationDurationSecs?: number;
  /** Narration duration estimated from word count and audio duration. */
  estimatedNarrationSecs: number;
  promptText: string;
  /** Original narration segments this clip covers, with per-segment timestamp detail. */
  coveredSegments: Array<{
    segmentIndex: number;
    text: string;
    timestampStartSeconds?: number;
    timestampEndSeconds?: number;
    /** Duration intended from this segment's timestamps. */
    intendedDurationSecs?: number;
  }>;
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
 */
function mixMusicUnderVoice(voicePath: string, audioDurationSecs: number): string {
  const musicEnvPath = process.env.REEL_MUSIC_PATH;
  const musicAssetPath = join(resolve('.'), MUSIC_ASSET_RELATIVE_PATH);

  let musicPath: string | null = null;
  if (musicEnvPath && existsSync(musicEnvPath)) {
    musicPath = musicEnvPath;
  } else if (existsSync(musicAssetPath)) {
    musicPath = musicAssetPath;
  }

  if (!musicPath) {
    console.log(
      '         no music track found — skipping music layer ' +
      '(set REEL_MUSIC_PATH or add assets/ambient-drone.mp3 to the repo)'
    );
    return voicePath;
  }

  console.log(`         mixing ambient music: ${musicPath}`);
  const mixedPath = join(TMP, 'voiceover-mixed.mp3');
  const fadeOutStart = Math.max(0, audioDurationSecs - 2.0).toFixed(3);

  try {
    execSync(
      `ffmpeg -y ` +
      `-stream_loop -1 -i "${musicPath}" ` +
      `-i "${voicePath}" ` +
      `-filter_complex ` +
        `"[0:a]volume=-18dB,` +
        `afade=t=in:st=0:d=1.5,` +
        `afade=t=out:st=${fadeOutStart}:d=2.0[music];` +
        `[music][1:a]amix=inputs=2:duration=shortest[out]" ` +
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

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':   elevenLabsKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text:     plan.script,
        model_id: plan.elevenLabs.modelId,
        ...(Object.keys(pureVoiceSettings).length > 0 ? { voice_settings: pureVoiceSettings } : {}),
        ...(speed !== undefined ? { speed } : {}),
      }),
    }
  );

  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);

  // ── 1a: Save raw TTS output ────────────────────────────────────────────────
  const rawAudioPath = join(TMP, 'voiceover-raw.mp3');
  writeFileSync(rawAudioPath, Buffer.from(await res.arrayBuffer()));
  const rawDuration = getMediaDuration(rawAudioPath);
  console.log(`         raw saved: ${rawAudioPath}  (${rawDuration.toFixed(1)}s)`);

  // ── 1b: Audio post-processing — EQ + LUFS normalisation ───────────────────
  const processedPath = processAudio(rawAudioPath);

  // ── 1c: Ambient music layer (optional) ────────────────────────────────────
  const finalAudioSource = mixMusicUnderVoice(processedPath, rawDuration);

  // Normalise to the canonical output filename the rest of the pipeline expects.
  const audioPath = join(TMP, 'voiceover.mp3');
  execSync(`cp "${finalAudioSource}" "${audioPath}"`);

  const finalDuration = getMediaDuration(audioPath);
  console.log(`         final : ${audioPath}  (${finalDuration.toFixed(1)}s)`);

  return audioPath;
}

// ── Step 2: Runway Gen-4 video ────────────────────────────────────────────────

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  const matches = normalizeWhitespace(text).match(/\b[\p{L}\p{N}''/\-]+\b/gu);
  return matches?.length ?? 0;
}

function splitWordsIntoChunks(text: string, chunkCount: number): string[] {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const safeChunkCount = Math.max(1, Math.min(chunkCount, words.length));
  const chunks: string[] = [];
  let start = 0;

  for (let i = 0; i < safeChunkCount; i++) {
    const remainingWords = words.length - start;
    const remainingChunks = safeChunkCount - i;
    const chunkSize = Math.ceil(remainingWords / remainingChunks);
    chunks.push(words.slice(start, start + chunkSize).join(' '));
    start += chunkSize;
  }

  return chunks;
}

function mergeTinyUnits(units: string[]): string[] {
  const merged: string[] = [];

  for (const unit of units) {
    if (countWords(unit) <= 3) {
      if (merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`.trim();
      } else {
        merged.push(unit);
      }
      continue;
    }

    merged.push(unit);
  }

  return merged;
}

function splitNarrationUnits(script: string): string[] {
  const normalized = normalizeWhitespace(script);
  if (!normalized) return [];

  const sentenceUnits = normalized
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  return mergeTinyUnits(sentenceUnits.flatMap(sentence => {
    if (countWords(sentence) <= 18) return [sentence];

    const clauses = sentence
      .split(/(?<=[,;:])\s+/)
      .map(clause => clause.trim())
      .filter(Boolean);

    if (clauses.length <= 1) {
      return splitWordsIntoChunks(sentence, Math.ceil(countWords(sentence) / 16));
    }

    return clauses.flatMap(clause => {
      if (countWords(clause) <= 18) return [clause];
      return splitWordsIntoChunks(clause, Math.ceil(countWords(clause) / 16));
    });
  }));
}

function limitWords(text: string, maxWords: number): string {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function sceneCue(index: number, totalScenes: number): string {
  if (totalScenes === 1) return 'Single continuous scene';
  if (index === 0) return 'Opening scene';
  if (index === totalScenes - 1) return 'Closing scene';
  return `Scene ${index + 1} of ${totalScenes}`;
}

export function buildSegmentPrompt(
  basePrompt: string,
  narrationChunk: string,
  clipIndex: number,
  totalClips: number,
  promptOverride?: string
): string {
  const promptAnchor = normalizeWhitespace(basePrompt).replace(/[.?!,;:\s]+$/, '');
  const sceneFocus = limitWords(promptOverride ?? narrationChunk, 24);
  return `${promptAnchor}. ${sceneCue(clipIndex, totalClips)}. Keep the same visual style and evolve the imagery to match: ${sceneFocus}`;
}

export function planClipDurations(audioDurationSecs: number, targetDurationSecs = audioDurationSecs): Array<5 | 10> {
  const requestedDuration = Math.max(audioDurationSecs, targetDurationSecs);
  const clampedTargetDuration = Math.max(5, Math.min(MAX_REEL_SECS, Math.ceil(requestedDuration)));
  const durations: Array<5 | 10> = [];
  let remaining = clampedTargetDuration;

  while (remaining > 0) {
    if (remaining > 10) {
      durations.push(10);
      remaining -= 10;
      continue;
    }

    durations.push(remaining <= 5 ? 5 : 10);
    break;
  }

  return durations;
}

interface ScenePlanningOptions {
  targetDurationSecs?: number;
  narrationSegments?: ResolvedNarrationSegment[];
}

interface NarrationUnit {
  text: string;
  promptText?: string;
  durationSecs?: number;
  /** Index into the original narrationSegments array. Undefined for auto-split units. */
  sourceSegmentIndex?: number;
}

function splitUnitDurationSecs(totalDurationSecs: number, pieceWordCount: number, totalPieceWords: number, pieceCount: number): number {
  if (pieceCount < 2) return 0;
  const weight = totalPieceWords > 0
    ? pieceWordCount / totalPieceWords
    : 1 / pieceCount;
  return Number((totalDurationSecs * weight).toFixed(3));
}

function ensureMinimumUnitCount(units: NarrationUnit[], minimumCount: number): NarrationUnit[] {
  const expanded = [...units];

  while (expanded.length < minimumCount) {
    let splitIndex = -1;
    let longestWordCount = 0;

    for (let i = 0; i < expanded.length; i++) {
      const wordCount = countWords(expanded[i].text);
      if (wordCount > longestWordCount && wordCount > 1) {
        longestWordCount = wordCount;
        splitIndex = i;
      }
    }

    if (splitIndex === -1) break;

    const unitToSplit = expanded[splitIndex];
    const pieces = splitWordsIntoChunks(unitToSplit.text, 2);
    if (pieces.length < 2) break;
    const pieceWordCounts = pieces.map(piece => countWords(piece));
    const totalPieceWords = pieceWordCounts.reduce((total, wordCount) => total + wordCount, 0);

    expanded.splice(
      splitIndex,
      1,
      ...pieces.map((text, index) => ({
        text,
        promptText: unitToSplit.promptText,
        durationSecs: unitToSplit.durationSecs !== undefined
          ? splitUnitDurationSecs(unitToSplit.durationSecs, pieceWordCounts[index], totalPieceWords, pieces.length)
          : undefined,
        sourceSegmentIndex: unitToSplit.sourceSegmentIndex,
      }))
    );
  }

  return expanded;
}

function resolveSegmentDurationSecs(
  segment: ResolvedNarrationSegment,
  nextSegment?: ResolvedNarrationSegment
): number | undefined {
  const startSeconds = segment.timestampStartSeconds;
  const endSeconds = segment.timestampEndSeconds ?? nextSegment?.timestampStartSeconds;

  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) {
    return undefined;
  }

  return Number((endSeconds - startSeconds).toFixed(3));
}

function getUnitNarrationSecs(unit: NarrationUnit, secondsPerWord: number): number {
  return unit.durationSecs ?? (countWords(unit.text) * secondsPerWord);
}

export function planNarrationScenes(
  script: string,
  basePrompt: string,
  audioDurationSecs: number,
  options: ScenePlanningOptions = {}
): ReelScenePlan[] {
  const clipDurations = planClipDurations(audioDurationSecs, options.targetDurationSecs);
  const normalizedScript = normalizeWhitespace(script);

  if (!normalizedScript) throw new Error('Narration script must contain non-whitespace content');

  const totalWords = countWords(normalizedScript);
  const secondsPerWord = totalWords > 0 ? audioDurationSecs / totalWords : 0;
  const totalClips = clipDurations.length;
  const explicitUnits = options.narrationSegments
    ?.map((segment, index, segments) => ({
      text: normalizeWhitespace(segment.text),
      promptText: segment.promptText ? normalizeWhitespace(segment.promptText) : undefined,
      durationSecs: resolveSegmentDurationSecs(segment, segments[index + 1]),
      sourceSegmentIndex: index,
    }))
    .filter(segment => segment.text);
  const seededUnits = explicitUnits && explicitUnits.length > 0
    ? explicitUnits
    : splitNarrationUnits(normalizedScript).map(text => ({ text }));
  const units = ensureMinimumUnitCount(seededUnits, totalClips);
  const segments: ReelScenePlan[] = [];
  let unitIndex = 0;

  for (let clipIndex = 0; clipIndex < totalClips; clipIndex++) {
    const clipDuration = clipDurations[clipIndex];
    const targetNarrationSecs = clipDuration;
    const minimumNarrationSecs = Math.max(2.5, clipDuration * 0.6);
    const segmentUnits: NarrationUnit[] = [];
    let segmentNarrationSecs = 0;

    while (unitIndex < units.length) {
      const unit = units[unitIndex];
      const unitNarrationSecs = getUnitNarrationSecs(unit, secondsPerWord);
      const projectedNarrationSecs = segmentNarrationSecs + unitNarrationSecs;
      const remainingUnits = units.length - (unitIndex + 1);
      const remainingClips = totalClips - (clipIndex + 1);
      const mustLeaveUnitsForRemainingClips = remainingUnits < remainingClips;

      if (segmentUnits.length === 0) {
        segmentUnits.push(unit);
        segmentNarrationSecs = projectedNarrationSecs;
        unitIndex++;
        continue;
      }

      if (mustLeaveUnitsForRemainingClips) break;
      if (segmentNarrationSecs < minimumNarrationSecs) {
        segmentUnits.push(unit);
        segmentNarrationSecs = projectedNarrationSecs;
        unitIndex++;
        continue;
      }

      const currentGap = Math.abs(segmentNarrationSecs - targetNarrationSecs);
      const projectedGap = Math.abs(projectedNarrationSecs - targetNarrationSecs);

      if (projectedNarrationSecs <= targetNarrationSecs || projectedGap <= currentGap) {
        segmentUnits.push(unit);
        segmentNarrationSecs = projectedNarrationSecs;
        unitIndex++;
        continue;
      }

      break;
    }

    if (clipIndex === totalClips - 1 && unitIndex < units.length) {
      segmentUnits.push(...units.slice(unitIndex));
      segmentNarrationSecs += units
        .slice(unitIndex)
        .reduce((total, unit) => total + getUnitNarrationSecs(unit, secondsPerWord), 0);
      unitIndex = units.length;
    }

    const narrationChunk = normalizeWhitespace(segmentUnits.map(unit => unit.text).join(' '));
    const promptOverride = normalizeWhitespace(
      segmentUnits
        .map(unit => unit.promptText)
        .filter((value): value is string => Boolean(value))
        .join(' ')
    );

    // Collect which original segments this clip covers (deduped, in order).
    const coveredSegmentIndices = [...new Set(
      segmentUnits
        .map(u => u.sourceSegmentIndex)
        .filter((i): i is number => i !== undefined)
    )];

    // Derive timestamp range and intended duration from covered segments.
    const narrationSegments = options.narrationSegments ?? [];
    let clipTimestampStart: number | undefined;
    let clipTimestampEnd: number | undefined;
    let intendedNarrationDurationSecs: number | undefined;
    if (coveredSegmentIndices.length > 0) {
      const firstSeg = narrationSegments[coveredSegmentIndices[0]];
      const lastSeg = narrationSegments[coveredSegmentIndices[coveredSegmentIndices.length - 1]];
      clipTimestampStart = firstSeg?.timestampStartSeconds;
      clipTimestampEnd = lastSeg?.timestampEndSeconds;
      if (
        clipTimestampStart !== undefined &&
        clipTimestampEnd !== undefined &&
        clipTimestampEnd > clipTimestampStart
      ) {
        intendedNarrationDurationSecs = Number((clipTimestampEnd - clipTimestampStart).toFixed(3));
      }
    }

    segments.push({
      clipIndex,
      clipDuration,
      estimatedNarrationSecs: Number(segmentNarrationSecs.toFixed(1)),
      narrationChunk,
      promptText: buildSegmentPrompt(
        basePrompt,
        narrationChunk,
        clipIndex,
        totalClips,
        promptOverride || undefined
      ),
      coveredSegmentIndices,
      timestampStartSeconds: clipTimestampStart,
      timestampEndSeconds: clipTimestampEnd,
      intendedNarrationDurationSecs,
    });
  }

  return segments;
}

/**
 * Builds a resolved scene timeline / allocation plan from a completed scene plan
 * and the original narration segments. Suitable for logging and artifact output.
 */
export function buildSceneTimeline(
  scenePlan: ReelScenePlan[],
  narrationSegments: ResolvedNarrationSegment[]
): SceneAllocationEntry[] {
  return scenePlan.map(scene => ({
    clipIndex: scene.clipIndex,
    clipDuration: scene.clipDuration,
    narrationText: scene.narrationChunk,
    timestampStartSeconds: scene.timestampStartSeconds,
    timestampEndSeconds: scene.timestampEndSeconds,
    intendedNarrationDurationSecs: scene.intendedNarrationDurationSecs,
    estimatedNarrationSecs: scene.estimatedNarrationSecs,
    promptText: scene.promptText,
    coveredSegments: scene.coveredSegmentIndices.map(idx => {
      const seg = narrationSegments[idx];
      return {
        segmentIndex: idx,
        text: seg?.text ?? '',
        timestampStartSeconds: seg?.timestampStartSeconds,
        timestampEndSeconds: seg?.timestampEndSeconds,
        intendedDurationSecs: seg
          ? resolveSegmentDurationSecs(seg, narrationSegments[idx + 1])
          : undefined,
      };
    }),
  }));
}

/** Formats seconds as M:SS for display. */
function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function generateRunwayClip(scene: ReelScenePlan, totalClips: number): Promise<string> {
  const { runwayKey } = getConfig();
  console.log(
    `         clip ${scene.clipIndex + 1}/${totalClips}: requesting ${scene.clipDuration}s for "${limitWords(scene.narrationChunk, 14)}"`
  );
  const createRes = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
    method:  'POST',
    headers: {
      'Authorization':   `Bearer ${runwayKey}`,
      'Content-Type':    'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      promptText: scene.promptText,
      model:      'gen4_turbo',
      ratio:      '720:1280',   // 9:16 — Instagram Reels portrait
      duration:   scene.clipDuration,
    }),
  });

  if (!createRes.ok) throw new Error(`Runway create ${createRes.status}: ${await createRes.text()}`);

  const { id } = await createRes.json() as { id: string };
  console.log(`         clip ${scene.clipIndex + 1}/${totalClips}: task id ${id}`);

  // Poll up to 5 minutes
  const deadline = Date.now() + RUNWAY_TIMEOUT_MS;
  let attempt    = 0;

  while (Date.now() < deadline) {
    await sleep(10_000);
    attempt++;

    const pollRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${id}`, {
      headers: {
        'Authorization':    `Bearer ${runwayKey}`,
        'X-Runway-Version': '2024-11-06',
      },
    });

    if (!pollRes.ok) {
      throw new Error(`Runway poll ${pollRes.status} for task ${id}: ${await pollRes.text()}`);
    }

    const task = await pollRes.json() as {
      status:   string;
      output?:  string[];
      failure?: string;
    };

    console.log(`         clip ${scene.clipIndex + 1}/${totalClips} [${attempt}] ${task.status}`);

    if (task.status === 'SUCCEEDED') {
      const videoUrl = task.output?.[0];
      if (!videoUrl) throw new Error(
        `Runway task ${id} succeeded but returned no output URL — this may indicate an API response change or incomplete generation`
      );

      const videoPath = join(TMP, `runway-${String(scene.clipIndex + 1).padStart(2, '0')}.mp4`);
      const dl        = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`Runway download ${dl.status} for task ${id}: ${await dl.text()}`);
      writeFileSync(videoPath, Buffer.from(await dl.arrayBuffer()));
      console.log(`         clip ${scene.clipIndex + 1}/${totalClips}: saved ${videoPath}`);
      return videoPath;
    }

    if (task.status === 'FAILED') {
      throw new Error(`Runway task failed: ${task.failure ?? 'unknown reason'}`);
    }
  }

  throw new Error(`Runway task ${id} timed out after ${RUNWAY_TIMEOUT_MS / 1000}s — try a shorter prompt or retry`);
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

  const clipPaths: string[] = [];
  for (const scene of scenePlan) {
    const clipPath = await generateRunwayClip(scene, scenePlan.length);
    clipPaths.push(clipPath);
  }

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

async function uploadToGitHubRelease(videoPath: string): Promise<string> {
  console.log('  [4/4] Uploading to GitHub Release…');
  const { githubToken } = getConfig();

  const tag  = `reel-${Date.now()}`;
  const name = `Reel ${new Date().toISOString().slice(0, 10)}`;

  // Create release
  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases`,
    {
      method:  'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
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
      'Authorization': `token ${githubToken}`,
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

async function main(): Promise<void> {
  const { plan } = getConfig();
  console.log('NDCH Vision — Reel Generator');
  console.log(`  engine config : ${plan.engineConfigPath ?? '(env only)'}`);
  console.log(`  reel spec     : ${plan.reelSpecPath ?? '(env only)'}`);
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
  const publicUrl = await uploadToGitHubRelease(finalPath);

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
    sceneTimeline,
  }, null, 2));
  console.log(`  resolved plan : ${resolvedPlanPath}`);

  // Expose to subsequent Actions steps
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `REEL_VIDEO_URL=${publicUrl}\n`);
    appendFileSync(process.env.GITHUB_ENV, `REEL_RESOLVED_PLAN_PATH=${resolvedPlanPath}\n`);
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
    console.error('');
    console.error('✗  Reel generation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
