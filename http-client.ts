const DEFAULT_RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504] as const;

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  retryableStatusCodes?: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;

  const message = error.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  );
}

async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<Response> {
  const {
    method = 'GET',
    headers,
    body,
    timeoutMs = 30_000,
    maxRetries = 3,
    initialRetryDelayMs = 750,
    retryableStatusCodes = [...DEFAULT_RETRYABLE_STATUS_CODES],
  } = options;

  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      if (!retryableStatusCodes.includes(response.status) || attempt >= maxRetries) {
        return response;
      }

      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : undefined;
      const backoffMs = retryAfterMs && Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : initialRetryDelayMs * (2 ** attempt);

      attempt += 1;
      await sleep(Math.min(backoffMs, 15_000));
      continue;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      await sleep(Math.min(initialRetryDelayMs * (2 ** (attempt - 1)), 15_000));
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const response = await httpRequest(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${url}: ${text.slice(0, 500)}`);
  }
}

export async function requestBuffer(url: string, options: HttpRequestOptions = {}): Promise<Buffer> {
  const response = await httpRequest(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${text}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function requestText(url: string, options: HttpRequestOptions = {}): Promise<string> {
  const response = await httpRequest(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${text}`);
  }

  return text;
}
