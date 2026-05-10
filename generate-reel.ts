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
 * Writes REEL_VIDEO_URL to $GITHUB_ENV so publish-reel.ts picks it up.
 *
 * Node ≥ 18 + ffmpeg on PATH required.
 */

import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { execSync }                                    from 'node:child_process';
import { randomUUID }                                  from 'node:crypto';
import { tmpdir }                                      from 'node:os';
import { join, resolve }                               from 'node:path';
import { fileURLToPath }                               from 'node:url';
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

const DEFAULT_VOICE_ID = 'C9Uh5MFptuXa176UlaXE';   // NDCH Vision cloned voice
const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2';
const REPO           = 'NDCHVISION/ndch-dreamforge-engine';
const TMP            = tmpdir();
const MAX_REEL_SECS  = 45;
const RUNWAY_TIMEOUT_MS = 300_000;

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

// ── Step 1: ElevenLabs voiceover ──────────────────────────────────────────────

async function generateVoiceover(): Promise<string> {
  console.log('  [1/4] Generating voiceover via ElevenLabs…');
  const { elevenLabsKey, plan } = getConfig();
  const voiceId = plan.elevenLabs.voiceId ?? DEFAULT_VOICE_ID;
  console.log(`         model: ${plan.elevenLabs.modelId}`);
  console.log(`         voice: ${voiceId}`);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':   elevenLabsKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text: plan.script,
        model_id: plan.elevenLabs.modelId,
        ...(plan.elevenLabs.voiceSettings ? { voice_settings: plan.elevenLabs.voiceSettings } : {}),
      }),
    }
  );

  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);

  const audioPath = join(TMP, 'voiceover.mp3');
  writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));

  const duration = getMediaDuration(audioPath);
  console.log(`         saved: ${audioPath}  (${duration.toFixed(1)}s)`);

  return audioPath;
}

// ── Step 2: Runway Gen-4 video ────────────────────────────────────────────────

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  const matches = normalizeWhitespace(text).match(/\b[\p{L}\p{N}'’/\-]+\b/gu);
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

    expanded.splice(
      splitIndex,
      1,
      ...pieces.map(text => ({ text, promptText: unitToSplit.promptText }))
    );
  }

  return expanded;
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
    ?.map(segment => ({
      text: normalizeWhitespace(segment.text),
      promptText: segment.promptText ? normalizeWhitespace(segment.promptText) : undefined,
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
    let segmentWordCount = 0;

    while (unitIndex < units.length) {
      const unit = units[unitIndex];
      const unitWordCount = countWords(unit.text);
      const projectedWordCount = segmentWordCount + unitWordCount;
      const currentNarrationSecs = segmentWordCount * secondsPerWord;
      const projectedSecs = projectedWordCount * secondsPerWord;
      const remainingUnits = units.length - (unitIndex + 1);
      const remainingClips = totalClips - (clipIndex + 1);
      const mustLeaveUnitsForRemainingClips = remainingUnits < remainingClips;

      if (segmentUnits.length === 0) {
        segmentUnits.push(unit);
        segmentWordCount = projectedWordCount;
        unitIndex++;
        continue;
      }

      if (mustLeaveUnitsForRemainingClips) break;
      if (currentNarrationSecs < minimumNarrationSecs) {
        segmentUnits.push(unit);
        segmentWordCount = projectedWordCount;
        unitIndex++;
        continue;
      }

      const currentGap = Math.abs(currentNarrationSecs - targetNarrationSecs);
      const projectedGap = Math.abs(projectedSecs - targetNarrationSecs);

      if (projectedSecs <= targetNarrationSecs || projectedGap <= currentGap) {
        segmentUnits.push(unit);
        segmentWordCount = projectedWordCount;
        unitIndex++;
        continue;
      }

      break;
    }

    if (clipIndex === totalClips - 1 && unitIndex < units.length) {
      segmentUnits.push(...units.slice(unitIndex));
      segmentWordCount += units
        .slice(unitIndex)
        .reduce((total, unit) => total + countWords(unit.text), 0);
      unitIndex = units.length;
    }

    const narrationChunk = normalizeWhitespace(segmentUnits.map(unit => unit.text).join(' '));
    const promptOverride = normalizeWhitespace(
      segmentUnits
        .map(unit => unit.promptText)
        .filter((value): value is string => Boolean(value))
        .join(' ')
    );
    segments.push({
      clipIndex,
      clipDuration,
      estimatedNarrationSecs: Number((segmentWordCount * secondsPerWord).toFixed(1)),
      narrationChunk,
      promptText: buildSegmentPrompt(
        basePrompt,
        narrationChunk,
        clipIndex,
        totalClips,
        promptOverride || undefined
      ),
    });
  }

  return segments;
}

async function generateRunwayClip(scene: ReelScenePlan, totalClips: number): Promise<string> {
  const { runwayKey } = getConfig();
  console.log(
    `         clip ${scene.clipIndex + 1}/${totalClips}: requesting ${scene.clipDuration}s for "${limitWords(scene.narrationChunk, 14)}"`
  );
  const createRes = await fetch('https://api.runwayml.com/v1/text_to_video', {
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

    const pollRes = await fetch(`https://api.runwayml.com/v1/tasks/${id}`, {
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

async function generateVideo(audioDurationSecs: number): Promise<string> {
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
  const durations = scenePlan.map(scene => scene.clipDuration);
  const plannedVisualSecs = durations.reduce((sum, d) => sum + d, 0);
  console.log(
    `         narration ${audioDurationSecs.toFixed(1)}s, target ${plan.targetDurationSeconds ?? 'auto'}s, planned visual target up to ${MAX_REEL_SECS}s, plan: ${durations.join(' + ')} = ${plannedVisualSecs}s`
  );
  scenePlan.forEach(scene => {
    console.log(
      `         scene ${scene.clipIndex + 1}/${scenePlan.length}: ~${scene.estimatedNarrationSecs.toFixed(1)}s narration, ${scene.clipDuration}s clip`
    );
    console.log(`           narration: ${scene.narrationChunk}`);
    console.log(`           prompt   : ${scene.promptText}`);
  });

  const clipPaths: string[] = [];
  for (const scene of scenePlan) {
    const clipPath = await generateRunwayClip(scene, scenePlan.length);
    clipPaths.push(clipPath);
  }

  const stitchedPath = stitchVideoClips(clipPaths);
  const stitchedDuration = getMediaDuration(stitchedPath);
  console.log(`         stitched duration: ${stitchedDuration.toFixed(1)}s`);
  return stitchedPath;
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
  }, null, 2));
  console.log(`  resolved plan : ${resolvedPlanPath}`);
  console.log('');

  const audioPath = await generateVoiceover();
  const durationSecs = getMediaDuration(audioPath);

  const videoPath = await generateVideo(durationSecs);
  const finalPath = mergeAudioVideo(audioPath, videoPath);
  const publicUrl = await uploadToGitHubRelease(finalPath);

  // Expose to subsequent Actions steps
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `REEL_VIDEO_URL=${publicUrl}\n`);
    appendFileSync(process.env.GITHUB_ENV, `REEL_RESOLVED_PLAN_PATH=${resolvedPlanPath}\n`);
    if (plan.instagram.caption) {
      const captionEnvDelimiter = `EOF_REEL_CAPTION_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
