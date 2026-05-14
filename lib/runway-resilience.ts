const DEFAULT_RUNWAY_POLL_DELAY_MS = 10_000;
const THROTTLED_RUNWAY_POLL_DELAY_MS = 45_000; // back off harder when server is throttling
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
  // gen4.5 costs 12 credits per second of generated video.
const GEN4_5_CREDITS_PER_SECOND = 12;

export function estimateRunwayCostCredits(scenes: Array<{ clipDuration: number }>): number {
  return scenes.reduce((sum, s) => sum + s.clipDuration * GEN4_5_CREDITS_PER_SECOND, 0);
}

export async function checkRunwayCreditBalance(runwayKey: string): Promise<number | null> {
  try {
    const res = await fetch('https://api.dev.runwayml.com/v1/organization', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${runwayKey}`,
        'X-Runway-Version': '2024-11-06',
      },
    });
    if (!res.ok) return null;
    const body = await res.json() as { creditBalance?: number };
    return typeof body.creditBalance === 'number' ? body.creditBalance : null;
  } catch {
    return null;
  }
}

export function assertSufficientRunwayCredits(balance: number | null, estimatedCost: number): void {
  if (balance === null) {
    console.warn('Could not read Runway credit balance; proceeding without preflight check.');
    return;
  }
  if (balance < estimatedCost) {
    throw new Error(
      `Insufficient Runway credits: balance is ${balance} but this run will need ~${estimatedCost} credits. ` +
      `Top up at https://dev.runwayml.com/billing before retrying.`
    );
  }
  console.log(`Runway credit preflight OK: balance ${balance} >= estimated ${estimatedCost} credits.`);

}
