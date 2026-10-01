import { describe, it, expect, vi } from 'vitest';
import { computeBackoff, runWithConcurrency, withRetry } from '../src/shared/queue.js';
import { JevError } from '../src/shared/errors.js';

describe('computeBackoff', () => {
  const options = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };

  it('returns half the base delay at attempt 1 with random() => 0 (50% jitter)', () => {
    expect(computeBackoff(1, options)).toBe(50);
  });

  it('doubles at attempt 2 with random() => 0', () => {
    expect(computeBackoff(2, options)).toBe(100);
  });

  it('is capped at maxDelayMs before jitter', () => {
    expect(computeBackoff(10, options)).toBe(500);
  });

  it('returns the un-jittered capped value with random() => 1', () => {
    const full = { ...options, random: () => 1 };
    expect(computeBackoff(1, full)).toBe(100);
    expect(computeBackoff(10, full)).toBe(1000);
  });
});

describe('withRetry', () => {
  const base = {
    retries: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    isRetryable: () => true,
  };

  it('succeeds without retrying on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, { ...base, sleep, random: () => 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error and eventually resolves', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new JevError('network', 'down'))
      .mockResolvedValue('recovered');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, { ...base, sleep, random: () => 0 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('stops after retries attempts and rethrows the last error', async () => {
    const error = new JevError('server', 'boom');
    const fn = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { ...base, retries: 2, sleep, random: () => 0 })).rejects.toBe(
      error,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    const error = new JevError('auth', 'bad key');
    const fn = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withRetry(fn, { ...base, isRetryable: () => false, sleep, random: () => 0 }),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours a JevError.retryAfterMs with that exact delay', async () => {
    const error = new JevError('rate_limit', 'slow down', { retryAfterMs: 4321 });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await withRetry(fn, { ...base, sleep, random: () => 0 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(4321);
  });

  it('calls onRetry with the attempt number', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new JevError('network', 'a'))
      .mockRejectedValueOnce(new JevError('network', 'b'))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await withRetry(fn, { ...base, sleep, random: () => 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].attempt).toBe(1);
    expect(onRetry.mock.calls[1][0].attempt).toBe(2);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const results = await runWithConcurrency(items, 3, async (item) => {
      live++;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
      return item * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('returns results in input order', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const results = await runWithConcurrency(items, 2, async (item) => {
      await Promise.resolve();
      return item.toUpperCase();
    });
    expect(results).toEqual(['A', 'B', 'C', 'D']);
  });

  it('handles an empty input', async () => {
    const worker = vi.fn();
    const results = await runWithConcurrency([], 4, worker);
    expect(results).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});
