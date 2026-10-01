import { CACHE_LIMIT, STORAGE_KEYS, freshDefaultSettings } from '../shared/defaults.js';
import { cacheIsStale, emptyCache, fingerprintSettings } from '../shared/cache.js';
import type { CacheState } from '../shared/cache.js';
import type { ProviderId, Settings } from '../shared/types.js';

/**
 * All chrome.storage.local access lives here and is imported only by the
 * service worker. The content script never reads keys.
 */

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings] as
    | Partial<Settings>
    | undefined;
  const base = freshDefaultSettings();
  if (!stored) return base;
  const categories =
    Array.isArray(stored.categories) && stored.categories.length > 0
      ? stored.categories
      : base.categories;
  return { ...base, ...stored, categories };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { ...current, ...patch };
  if (patch.categories) next.categories = patch.categories;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  // A provider/category/threshold change invalidates the cache.
  const cache = await readCache(next);
  await writeCache(cache);
  return next;
}

export async function readCache(settings: Settings): Promise<CacheState> {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.cache))[STORAGE_KEYS.cache] as
    | CacheState
    | undefined;
  const fingerprint = fingerprintSettings(settings);
  if (!stored || !stored.entries || !Array.isArray(stored.order) || cacheIsStale(stored, settings)) {
    return emptyCache(fingerprint);
  }
  return stored;
}

export async function writeCache(state: CacheState): Promise<void> {
  void CACHE_LIMIT;
  await chrome.storage.local.set({ [STORAGE_KEYS.cache]: state });
}

export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.cache);
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.cache);
  const stored = raw[STORAGE_KEYS.cache] as CacheState | undefined;
  if (!stored || !stored.entries) return { count: 0, bytes: 0 };
  const bytes = new TextEncoder().encode(JSON.stringify(stored)).length;
  return { count: Object.keys(stored.entries).length, bytes };
}

export async function getKey(provider: ProviderId): Promise<string | undefined> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.key(provider));
  const value = raw[STORAGE_KEYS.key(provider)];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function setKey(provider: ProviderId, apiKey: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.key(provider)]: apiKey.trim() });
}

export async function clearKey(provider: ProviderId): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.key(provider));
}

/** Last 4 characters only — never the whole key. */
export async function keyStatus(): Promise<Partial<Record<ProviderId, string>>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const provider of ['typesafe', 'vercel-gateway'] as ProviderId[]) {
    const key = await getKey(provider);
    if (key) out[provider] = key.slice(-4);
  }
  return out;
}
