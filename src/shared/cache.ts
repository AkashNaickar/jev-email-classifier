import { CACHE_LIMIT } from './defaults.js';
import type { Classification, Settings } from './types.js';
import { stableHash } from './util.js';

export interface CacheEntry {
  classification: Classification;
  at: number;
}

export interface CacheMeta {
  /** Provider + category + threshold fingerprint; a change invalidates the cache. */
  fingerprint: string;
}

export interface CacheState {
  entries: Record<string, CacheEntry>;
  /** LRU order: least-recently-used first, most-recent last. */
  order: string[];
  meta: CacheMeta;
}

export function emptyCache(fingerprint = ''): CacheState {
  return { entries: {}, order: [], meta: { fingerprint } };
}

/**
 * Fingerprint the settings that affect classification output. The cache is
 * cleared whenever the provider or the categories change.
 */
export function fingerprintSettings(settings: Settings): string {
  const categories = [...(settings.categories ?? [])]
    .map((c) => ({ id: c.id, name: c.name, description: c.description }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return stableHash(
    JSON.stringify({
      provider: settings.provider,
      categories,
      confidenceThreshold: settings.confidenceThreshold,
      priorityHighThreshold: settings.priorityHighThreshold,
      priorityLowThreshold: settings.priorityLowThreshold,
      privacyMode: settings.privacyMode,
    }),
  );
}

export function cacheIsStale(state: CacheState, settings: Settings): boolean {
  return state.meta.fingerprint !== fingerprintSettings(settings);
}

function touch(state: CacheState, hash: string): void {
  const idx = state.order.indexOf(hash);
  if (idx !== -1) state.order.splice(idx, 1);
  state.order.push(hash);
}

export function cacheGet(state: CacheState, hash: string): CacheEntry | undefined {
  const entry = state.entries[hash];
  if (!entry) return undefined;
  touch(state, hash);
  return entry;
}

export function cacheSet(
  state: CacheState,
  hash: string,
  classification: Classification,
  limit = CACHE_LIMIT,
  now = Date.now(),
): void {
  state.entries[hash] = { classification, at: now };
  touch(state, hash);
  cachePrune(state, limit);
}

/** Evict least-recently-used entries until at or below the limit. */
export function cachePrune(state: CacheState, limit = CACHE_LIMIT): number {
  // Drop any order ids with no matching entry first (defensive).
  state.order = state.order.filter((h) => h in state.entries);
  let evicted = 0;
  while (state.order.length > limit) {
    const oldest = state.order.shift();
    if (oldest && oldest in state.entries) {
      delete state.entries[oldest];
      evicted++;
    }
  }
  return evicted;
}

export function cacheSize(state: CacheState): number {
  return Object.keys(state.entries).length;
}
