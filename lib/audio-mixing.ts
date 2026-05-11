export const MUSIC_BED_GAIN_DB = -18;
export const MUSIC_FADE_IN_SECS = 1.5;
export const MUSIC_FADE_OUT_SECS = 2.0;

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
  const fadeOutStart = Math.max(0, audioDurationSecs - MUSIC_FADE_OUT_SECS).toFixed(3);

  return (
    `[0:a]volume=${MUSIC_BED_GAIN_DB}dB,` +
    `afade=t=in:st=0:d=${MUSIC_FADE_IN_SECS},` +
    `afade=t=out:st=${fadeOutStart}:d=${MUSIC_FADE_OUT_SECS}[music];` +
    `[1:a]asplit=2[voice][duckref];` +
    `[music][duckref]sidechaincompress=threshold=0.030:ratio=10:attack=25:release=300:makeup=1[ducked];` +
    `[ducked][voice]amix=inputs=2:duration=shortest[out]`
  );
}
