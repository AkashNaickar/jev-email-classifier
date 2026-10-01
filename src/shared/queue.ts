import { JevError } from './errors.js';

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}

/**
 * Exponential backoff with jitter (attempt is 1-based). Deterministic when the
 * caller injects `random`.
 */
export function computeBackoff(attempt: number, options: BackoffOptions): number {
  const exp = options.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(options.maxDelayMs, exp);
  const jitter = 0.5 + options.random() * 0.5; // 50%..100%
  return Math.round(capped * jitter);
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  /** Delay to use for server-signalled backoff (e.g. retry-after). */
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultRetryAfter(error: unknown): number | undefined {
  return error instanceof JevError ? error.retryAfterMs : undefined;
}

/** Run `fn`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retryAfterMs = options.retryAfterMs ?? defaultRetryAfter;

  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < options.retries && options.isRetryable(error);
      if (!canRetry) throw error;
      const serverDelay = retryAfterMs(error);
      const delayMs =
        serverDelay !== undefined && serverDelay >= 0
          ? serverDelay
          : computeBackoff(attempt + 1, {
              baseDelayMs: options.baseDelayMs,
              maxDelayMs: options.maxDelayMs,
              random,
            });
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Run `worker` over `items` with a bounded number in flight. Results keep the
 * input order. The worker is expected to handle its own per-item errors; a
 * thrown error rejects the whole call.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));

  async function drain(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, () => drain()));
  return results;
}
