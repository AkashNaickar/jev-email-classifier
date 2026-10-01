import { describe, it, expect } from 'vitest';
import {
  cacheGet,
  cacheIsStale,
  cachePrune,
  cacheSet,
  cacheSize,
  emptyCache,
  fingerprintSettings,
} from '../src/shared/cache.js';
import { freshDefaultSettings } from '../src/shared/defaults.js';
import type { Classification, Settings } from '../src/shared/types.js';

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    emailId: 'id',
    hash: 'hash',
    categoryId: 'updates',
    categoryName: 'Updates',
    categoryConfidence: 0.9,
    probabilities: {},
    priority: 'medium',
    priorityScore: 0.5,
    priorityConfidence: 0.8,
    spamProbability: 0.1,
    needsReplyProbability: 0.2,
    uncertain: false,
    model: 'jev-latest',
    provider: 'typesafe',
    at: 1,
    ...overrides,
  };
}

describe('cacheSet / cacheGet', () => {
  it('returns the entry that was set and persists it at the hash', () => {
    const state = emptyCache();
    const value = classification({ hash: 'h1' });
    cacheSet(state, 'h1', value, 10, 42);
    const entry = cacheGet(state, 'h1');
    expect(entry).toBeDefined();
    expect(entry?.classification).toBe(value);
    expect(entry?.at).toBe(42);
    expect(state.entries.h1).toBeDefined();
  });

  it('returns undefined for a missing hash', () => {
    const state = emptyCache();
    expect(cacheGet(state, 'nope')).toBeUndefined();
  });
});

describe('LRU eviction', () => {
  it('evicts the least-recently-used key when inserting limit + 1 distinct keys', () => {
    const state = emptyCache();
    cacheSet(state, 'a', classification(), 2);
    cacheSet(state, 'b', classification(), 2);
    cacheSet(state, 'c', classification(), 2);
    expect(cacheSize(state)).toBe(2);
    expect(cacheGet(state, 'a')).toBeUndefined();
    expect(cacheGet(state, 'b')).toBeDefined();
    expect(cacheGet(state, 'c')).toBeDefined();
  });

  it('changes which key survives when a get touches a key before exceeding the limit', () => {
    const state = emptyCache();
    cacheSet(state, 'a', classification(), 2);
    cacheSet(state, 'b', classification(), 2);
    // Touch 'a' so 'b' becomes the least-recently-used.
    expect(cacheGet(state, 'a')).toBeDefined();
    cacheSet(state, 'c', classification(), 2);
    expect(cacheGet(state, 'b')).toBeUndefined();
    expect(cacheGet(state, 'a')).toBeDefined();
    expect(cacheGet(state, 'c')).toBeDefined();
  });
});

describe('cachePrune', () => {
  it('never leaves more than limit entries', () => {
    const state = emptyCache();
    for (let i = 0; i < 10; i++) cacheSet(state, `k${i}`, classification(), 3);
    expect(cacheSize(state)).toBe(3);
    expect(state.order).toHaveLength(3);
  });

  it('removes order entries with no backing entry', () => {
    const state = emptyCache();
    cacheSet(state, 'a', classification(), 10);
    cacheSet(state, 'b', classification(), 10);
    delete state.entries.a;
    const evicted = cachePrune(state, 10);
    expect(evicted).toBe(0);
    expect(state.order).toEqual(['b']);
  });
});

describe('fingerprintSettings / cacheIsStale', () => {
  it('changes when the provider changes', () => {
    const base = freshDefaultSettings();
    const other: Settings = { ...base, provider: 'vercel-gateway' };
    expect(fingerprintSettings(base)).not.toBe(fingerprintSettings(other));
  });

  it('changes when a category description changes', () => {
    const base = freshDefaultSettings();
    const changed: Settings = {
      ...base,
      categories: base.categories.map((c, i) =>
        i === 0 ? { ...c, description: `${c.description} (edited)` } : c,
      ),
    };
    expect(fingerprintSettings(base)).not.toBe(fingerprintSettings(changed));
  });

  it('reports stale after a change and fresh when unchanged', () => {
    const base = freshDefaultSettings();
    const state = emptyCache(fingerprintSettings(base));
    expect(cacheIsStale(state, base)).toBe(false);

    const changed: Settings = { ...base, provider: 'vercel-gateway' };
    expect(cacheIsStale(state, changed)).toBe(true);
  });
});
