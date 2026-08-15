import { SAFETY_LIMITS } from "./safety-limits.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function exponentialDelay(attempt: number): number {
  return SAFETY_LIMITS.providerBackoffBaseMs * Math.pow(2, attempt);
}

export async function fetchWithProviderBackoff(
  input: string | URL | Request,
  init?: RequestInit,
  label = "provider",
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= SAFETY_LIMITS.providerMaxRetries; attempt++) {
    try {
      const response = await fetch(input, init);
      lastResponse = response;
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === SAFETY_LIMITS.providerMaxRetries) return response;
      const delay = Math.min(retryAfterMs(response) ?? exponentialDelay(attempt), 30_000);
      console.warn(`[Backoff] ${label} returned ${response.status}; retrying in ${delay}ms`);
      await sleep(delay);
    } catch (error) {
      if (attempt === SAFETY_LIMITS.providerMaxRetries) throw error;
      const delay = Math.min(exponentialDelay(attempt), 30_000);
      console.warn(`[Backoff] ${label} network error; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(delay);
    }
  }
  if (lastResponse) return lastResponse;
  throw new Error(`${label} request failed without a response`);
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  label: string,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SAFETY_LIMITS.providerMaxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === SAFETY_LIMITS.providerMaxRetries) throw error;
      const delay = Math.min(exponentialDelay(attempt), 30_000);
      console.warn(`[Backoff] ${label} transient failure; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function looksTransientProviderError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b(408|425|429|500|502|503|504)\b|rate.?limit|too many requests|temporar|timeout|timed out|service unavailable|connection reset/i.test(text);
}
