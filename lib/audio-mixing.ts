export const MUSIC_BED_GAIN_DB = -18;
export const MUSIC_FADE_IN_SECS = 1.5;
export const MUSIC_FADE_OUT_SECS = 2.0;
export const FADE_TIMING_PRECISION = 3;
// Sidechain tuning for voice-forward reels:
// - threshold (linear amplitude): when narration exceeds this level, duck music
// - ratio: compression strength applied to music while narration is active
// - attack/release (ms): fast enough for clarity, slow enough to avoid pumping
// - makeup: slight post-compression lift to keep music bed present
export const MUSIC_DUCKING_FILTER =
  'threshold=0.030:ratio=10:attack=25:release=300:makeup=1';

export function computeFadeOutStartSecsFormatted(audioDurationSecs: number): string {
  return Math.max(0, audioDurationSecs - MUSIC_FADE_OUT_SECS).toFixed(FADE_TIMING_PRECISION);
}

/**
 * Resolves music source path using current precedence:
 *   1) explicit env path
 *   2) repo ambient asset (if present)
 *   3) no music
 */
export function resolveMusicTrackPath(
  musicEnvPath: string | undefined,
  musicAssetPath: string,
  musicAssetExists: boolean,
): string | null {
  if (musicEnvPath) return musicEnvPath;
  if (musicAssetExists) return musicAssetPath;
  return null;
}

/**
 * Builds the FFmpeg filter graph for adaptive narration-aware music ducking.
 * Keeps existing music fades while using sidechain compression to duck music
 * under the voice and recover smoothly between narration peaks.
 */
export function buildAdaptiveMusicMixFilter(audioDurationSecs: number): string {
  const fadeOutStart = computeFadeOutStartSecsFormatted(audioDurationSecs);

  // Tuned for voice-forward narration: deeper reduction while voice is present,
  // then smooth recovery to avoid obvious "pumping" artifacts in the music bed.
  return (
    `[0:a]volume=${MUSIC_BED_GAIN_DB}dB,` +
    `afade=t=in:st=0:d=${MUSIC_FADE_IN_SECS},` +
    `afade=t=out:st=${fadeOutStart}:d=${MUSIC_FADE_OUT_SECS}[music];` +
    `[1:a]asplit=2[voice][duckref];` +
    `[music][duckref]sidechaincompress=${MUSIC_DUCKING_FILTER}[ducked];` +
    `[ducked][voice]amix=inputs=2:duration=shortest[out]`
  );
}
