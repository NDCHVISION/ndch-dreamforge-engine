import { ENGINE_DEFAULTS } from '../engine-defaults.ts';
import { type ResolvedNarrationSegment } from '../reel-plan.ts';

const MAX_REEL_SECS = ENGINE_DEFAULTS.maxDurationSeconds;
const MAX_RUNWAY_PROMPT_CHARS = 1000;

export type SceneRole = 'opening' | 'middle' | 'closing';

export interface ReelScenePlan {
  clipIndex: number;
  clipDuration: 5 | 10;
  role: SceneRole;
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

export interface ScenePlanningOptions {
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

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const matches = normalizeWhitespace(text).match(/\b[\p{L}\p{N}'/-]+\b/gu);
  return matches?.length ?? 0;
}

export function splitWordsIntoChunks(text: string, chunkCount: number): string[] {
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

function isLikelyFillerTinyUnit(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase().replace(/[.!?,;:]+$/g, '');
  if (!normalized) return true;

  const fillerPhrases = new Set([
    'and',
    'but',
    'so',
    'then',
    'now',
    'well',
    'okay',
    'ok',
    'right',
    'you know',
  ]);
  return fillerPhrases.has(normalized);
}

function looksPunchyOpeningLine(text: string): boolean {
  const words = countWords(text);
  if (words === 0 || words > 6) return false;
  if (isLikelyFillerTinyUnit(text)) return false;
  return /[.!?]$/.test(text.trim());
}

function looksDeclarativeClosingLine(text: string): boolean {
  const words = countWords(text);
  if (words === 0 || words > 8) return false;
  if (isLikelyFillerTinyUnit(text)) return false;
  return /[.!?]$/.test(text.trim());
}

export function mergeTinyUnits(units: string[]): string[] {
  const merged: string[] = [];

  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const unit = units[unitIndex];
    const wordCount = countWords(unit);
    if (wordCount <= 3) {
      const isOpeningHook = unitIndex === 0 && looksPunchyOpeningLine(unit);
      const isClosingBeat = unitIndex === units.length - 1 && looksDeclarativeClosingLine(unit);
      const shouldPreserveAsStandalone = isOpeningHook || isClosingBeat;

      if (shouldPreserveAsStandalone || merged.length === 0) {
        merged.push(unit);
      } else {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`.trim();
      }
      continue;
    }

    merged.push(unit);
  }

  return merged;
}

export function splitNarrationUnits(script: string): string[] {
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

export function limitWords(text: string, maxWords: number): string {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function sceneRoleForIndex(index: number, totalScenes: number): SceneRole {
  if (totalScenes <= 1) return 'opening';
  if (index === 0) return 'opening';
  if (index === totalScenes - 1) return 'closing';
  return 'middle';
}

function compactVisualFocus(text: string): string {
  let focus = normalizeWhitespace(text);
  if (!focus) return focus;

  focus = focus.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  const weakLeadInPattern = /^(?:in this scene|this scene shows|we see|we watch|we begin with|we start with|there is|there are|it is|this is|the idea is)\b[:,\s-]*/i;
  while (weakLeadInPattern.test(focus)) {
    focus = focus.replace(weakLeadInPattern, '');
  }
  focus = focus.replace(
    /\b(?:basically|just|really|actually|simply|kind of|sort of|you know|like)\b/gi,
    ''
  );

  return normalizeWhitespace(focus.replace(/\s+([,.;:!?])/g, '$1'));
}

interface RolePromptDirectives {
  roleLine: string;
  composition: string;
  motion: string;
  atmosphere: string;
  continuity: string;
  tone: string;
}

function rolePromptDirectives(role: SceneRole): RolePromptDirectives {
  if (role === 'opening') {
    return {
      roleLine: 'Hook instantly with a striking first image and clear emotion.',
      composition: 'Bold composition: dominant subject, readable silhouette, immediate depth.',
      motion: 'Cinematic reveal or push-in that grabs attention in the first beat.',
      atmosphere: 'High-contrast light with rich atmosphere and texture.',
      continuity: 'Establish the visual world, palette, and motifs for later scenes.',
      tone: 'Emotion is immediate, vivid, and legible.',
    };
  }

  if (role === 'closing') {
    return {
      roleLine: 'Deliver a resolved final image that feels iconic and memorable.',
      composition: 'Simplified final tableau with clean lines and strong subject clarity.',
      motion: 'Motion decelerates into a confident hold on the last frame.',
      atmosphere: 'Refined atmospheric light that supports final visual clarity.',
      continuity: 'Resolve within the same world using established motifs and palette.',
      tone: 'Emotional landing: earned, calm, and definitive.',
    };
  }

  return {
    roleLine: 'Advance the narrative with visible progression inside the same world.',
    composition: 'Evolving composition that shows transformation and deepening metaphor.',
    motion: 'Cinematic tracking/orbit/parallax movement that carries momentum.',
    atmosphere: 'Lighting and atmosphere evolve while preserving visual coherence.',
    continuity: 'Continue established style language, motifs, and texture continuity.',
    tone: 'Emotion deepens with mounting intensity and purpose.',
  };
}

export function sceneCue(index: number, totalScenes: number): string {
  if (totalScenes === 1) return 'Single continuous scene';
  const role = sceneRoleForIndex(index, totalScenes);
  if (role === 'opening') return 'Opening scene';
  if (role === 'closing') return 'Closing scene';
  return `Scene ${index + 1} of ${totalScenes}`;
}

export function buildSegmentPrompt(
  basePrompt: string,
  narrationChunk: string,
  clipIndex: number,
  totalClips: number,
  promptOverride?: string
): string {
  const role = sceneRoleForIndex(clipIndex, totalClips);
  const directives = rolePromptDirectives(role);
  const sceneFocus = limitWords(compactVisualFocus(promptOverride ?? narrationChunk), 24);
  const promptSuffix = `${sceneCue(clipIndex, totalClips)}. ${directives.roleLine} Composition: ${directives.composition} Motion: ${directives.motion} Lighting/atmosphere: ${directives.atmosphere} Continuity: ${directives.continuity} Tone: ${directives.tone} Visual focus: ${sceneFocus}`;
  const normalizedAnchor = normalizeWhitespace(basePrompt).replace(/[.?!,;:\s]+$/, '');
  const maxAnchorLength = Math.max(0, MAX_RUNWAY_PROMPT_CHARS - promptSuffix.length - 2);
  const promptAnchor = normalizedAnchor.slice(0, maxAnchorLength);
  const assembled = promptAnchor ? `${promptAnchor}. ${promptSuffix}` : promptSuffix;
  return assembled.slice(0, MAX_RUNWAY_PROMPT_CHARS);
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
      ...pieces.map((text, pieceIndex) => ({
        text,
        promptText: unitToSplit.promptText,
        durationSecs: unitToSplit.durationSecs !== undefined
          ? splitUnitDurationSecs(unitToSplit.durationSecs, pieceWordCounts[pieceIndex], totalPieceWords, pieces.length)
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

function shouldLockOpeningHook(unit: NarrationUnit | undefined, totalClips: number): boolean {
  return totalClips > 1 && Boolean(unit) && looksPunchyOpeningLine(unit.text);
}

function shouldLockClosingBeat(unit: NarrationUnit | undefined, totalClips: number): boolean {
  return totalClips > 1 && Boolean(unit) && looksDeclarativeClosingLine(unit.text);
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
  const usingAutoSplitUnits = !(explicitUnits && explicitUnits.length > 0);
  const seededUnits = explicitUnits && explicitUnits.length > 0
    ? explicitUnits
    : splitNarrationUnits(normalizedScript).map(text => ({ text }));
  const units = ensureMinimumUnitCount(seededUnits, totalClips);
  const segments: ReelScenePlan[] = [];
  const lockOpeningHook = usingAutoSplitUnits && shouldLockOpeningHook(units[0], totalClips);
  const lockClosingBeat = usingAutoSplitUnits && shouldLockClosingBeat(units[units.length - 1], totalClips);
  let unitIndex = 0;

  for (let clipIndex = 0; clipIndex < totalClips; clipIndex++) {
    const clipDuration = clipDurations[clipIndex];
    const targetNarrationSecs = clipDuration;
    const minimumNarrationSecs = Math.max(2.5, clipDuration * 0.6);
    const segmentUnits: NarrationUnit[] = [];
    let segmentNarrationSecs = 0;

    while (unitIndex < units.length) {
      const unit = units[unitIndex];
      const isFirstUnit = unitIndex === 0;
      const isLastUnit = unitIndex === units.length - 1;
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

      const shouldStopAfterOpeningHook = lockOpeningHook
        && clipIndex === 0
        && isFirstUnit === false
        && segmentUnits.length === 1;
      if (shouldStopAfterOpeningHook) {
        break;
      }

      if (lockClosingBeat && isLastUnit && clipIndex < totalClips - 1) {
        break;
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
      role: sceneRoleForIndex(clipIndex, totalClips),
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
