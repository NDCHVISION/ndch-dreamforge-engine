const DEFAULT_RUNWAY_POLL_DELAY_MS = 10_000;
const THROTTLED_RUNWAY_POLL_DELAY_MS = 20_000;
const MAX_RUNWAY_RETRY_DELAY_MS = 60_000;
const BASE_RUNWAY_RETRY_DELAY_MS = 15_000;

export function getRunwayPollDelayMs(status: string | undefined): number {
  if (status?.toUpperCase() === 'THROTTLED') {
    return THROTTLED_RUNWAY_POLL_DELAY_MS;
  }
  return DEFAULT_RUNWAY_POLL_DELAY_MS;
}

export function getRunwayRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return BASE_RUNWAY_RETRY_DELAY_MS;
  return Math.min(BASE_RUNWAY_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RUNWAY_RETRY_DELAY_MS);
}
