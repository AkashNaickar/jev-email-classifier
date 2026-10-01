import { USD_PER_INPUT_TOKEN } from './defaults.js';
import type { JevResponse } from './types.js';

/**
 * Estimate the USD cost of a request from token usage.
 * Prefers the gateway's reported cost, falls back to TypeSafe's published
 * $0.042 per 1M input tokens. Output tokens are free.
 */
export function estimateCostUsd(inputTokens: number, outputTokens = 0): number {
  void outputTokens; // output tokens are free
  return inputTokens * USD_PER_INPUT_TOKEN;
}

export function costFromResponse(response: JevResponse): number | undefined {
  const raw = response.provider_metadata?.gateway?.cost;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (response.usage) return estimateCostUsd(response.usage.input_tokens, response.usage.output_tokens);
  return undefined;
}

export function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
