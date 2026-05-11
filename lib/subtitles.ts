import { type SceneAllocationEntry, normalizeWhitespace, countWords } from './scene-planning.ts';

export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/** Maximum words per subtitle cue. Optimised for mobile/vertical viewing. */
export const MAX_WORDS_PER_CUE = 10;

/** Minimum readable cue duration in seconds. Prevents flash cues. */
export const MIN_CUE_DURATION_SECS = 1.2;

/** Maximum characters per subtitle line before attempting a line break. */
export const MAX_CHARS_PER_LINE = 42;

/**
 * Splits a narration text block into subtitle-sized phrases.
 *
 * Segmentation order:
 *   1. Sentence boundaries (`.` `!` `?`)
 *   2. Clause / punctuation boundaries (`,` `;` `:` `—` `–`)
 *   3. Word-count fallback at `maxWordsPerPhrase`
 */
export function splitIntoPhrases(
  text: string,
  maxWordsPerPhrase: number = MAX_WORDS_PER_CUE,
): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  // Step 1: split at sentence endings, keeping the punctuation attached.
  // Match runs of non-sentence-ending chars followed by optional sentence punctuation.
  const rawSentences = normalized.match(/[^.!?]+[.!?]*/g) ?? [normalized];
  const sentences = rawSentences.map(s => s.trim()).filter(Boolean);

  const result: string[] = [];

  for (const sentence of sentences) {
    if (countWords(sentence) <= maxWordsPerPhrase) {
      result.push(sentence);
      continue;
    }

    // Step 2: split at clause / punctuation boundaries, keeping delimiter on left.
    const clauseParts = sentence.split(/(?<=[,;:—–])\s+/);
    const buffer: string[] = [];
    let bufferWords = 0;

    for (const clause of clauseParts) {
      const clauseWords = countWords(clause);

      if (bufferWords > 0 && bufferWords + clauseWords > maxWordsPerPhrase) {
        const flushed = buffer.join(' ').trim();
        if (flushed) result.push(flushed);
        buffer.length = 0;
        bufferWords = 0;
      }

      buffer.push(clause);
      bufferWords += clauseWords;
    }

    if (buffer.length > 0) {
      const remaining = buffer.join(' ').trim();
      if (countWords(remaining) <= maxWordsPerPhrase) {
        result.push(remaining);
      } else {
        // Step 3: word-count fallback
        const words = remaining.split(/\s+/).filter(Boolean);
        for (let i = 0; i < words.length; i += maxWordsPerPhrase) {
          result.push(words.slice(i, i + maxWordsPerPhrase).join(' '));
        }
      }
    }
  }

  return result.filter(Boolean);
}

/**
 * Wraps subtitle text into at most two lines for mobile readability.
 * Tries to break near the visual midpoint without exceeding `maxCharsPerLine`.
 * Returns the original text unchanged when it fits on a single line.
 */
export function wrapSubtitleText(
  text: string,
  maxCharsPerLine: number = MAX_CHARS_PER_LINE,
): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxCharsPerLine) return normalized;

  const words = normalized.split(' ');
  if (words.length < 2) return normalized;

  const total = normalized.length;
  let bestBreakIndex = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < words.length - 1; i++) {
    const line1 = words.slice(0, i + 1).join(' ');
    if (line1.length > maxCharsPerLine) break;
    const diff = Math.abs(line1.length - total / 2);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestBreakIndex = i;
    }
  }

  const line1 = words.slice(0, bestBreakIndex + 1).join(' ');
  const line2 = words.slice(bestBreakIndex + 1).join(' ');

  if (line2.length > maxCharsPerLine) {
    // Cannot produce two clean lines — return single-line unchanged.
    return normalized;
  }

  return `${line1}\n${line2}`;
}

/**
 * Builds fallback subtitle cues from scene timeline entries.
 *
 * - Splits each entry's narration text into phrase-sized cues using
 *   `splitIntoPhrases`.
 * - Allocates cue duration proportionally by word count.
 * - Enforces a minimum readable duration per cue.
 * - Produces monotonically non-overlapping cue timing.
 */
export function buildFallbackSubtitleCues(
  entries: SceneAllocationEntry[],
  options?: {
    maxWordsPerCue?: number;
    minCueDurationSecs?: number;
    maxCharsPerLine?: number;
  },
): SubtitleCue[] {
  const maxWords = options?.maxWordsPerCue ?? MAX_WORDS_PER_CUE;
  const minDuration = options?.minCueDurationSecs ?? MIN_CUE_DURATION_SECS;
  const maxChars = options?.maxCharsPerLine ?? MAX_CHARS_PER_LINE;

  const cues: SubtitleCue[] = [];
  let cursor = 0;

  for (const entry of entries) {
    const text = normalizeWhitespace(entry.narrationText);
    if (!text) continue;

    const sceneDuration = Math.max(
      minDuration,
      entry.intendedNarrationDurationSecs ?? entry.estimatedNarrationSecs,
    );

    const phrases = splitIntoPhrases(text, maxWords);
    if (phrases.length === 0) continue;

    // Compute word counts for proportional duration allocation.
    const wordCounts = phrases.map(p => Math.max(1, countWords(p)));
    const totalWords = wordCounts.reduce((sum, n) => sum + n, 0);

    // Enforce minimum duration per phrase; accumulate timing from cursor.
    let phraseStart = cursor;

    for (let i = 0; i < phrases.length; i++) {
      const proportion = wordCounts[i] / totalWords;
      const duration = Math.max(minDuration, sceneDuration * proportion);

      cues.push({
        startSeconds: phraseStart,
        endSeconds: phraseStart + duration,
        text: wrapSubtitleText(phrases[i], maxChars),
      });

      phraseStart += duration;
    }

    cursor = phraseStart;
  }

  return cues;
}
