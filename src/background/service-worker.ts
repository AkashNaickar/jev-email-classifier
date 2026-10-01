import { JevError } from '../shared/errors.js';
import { buildJevState } from '../shared/metadata.js';
import { buildQuestions } from '../shared/questions.js';
import { classificationFromResponse } from '../shared/parse.js';
import { costFromResponse } from '../shared/cost.js';
import { createProvider } from '../shared/provider.js';
import { cacheGet, cacheSet, fingerprintSettings } from '../shared/cache.js';
import type { CacheState } from '../shared/cache.js';
import { runWithConcurrency, withRetry } from '../shared/queue.js';
import type {
  BackgroundToContent,
  BackgroundToUi,
  Classification,
  EmailMetadata,
  ErrorInfo,
  ProviderId,
  Settings,
  StatusStats,
} from '../shared/types.js';
import {
  cacheStats,
  clearCache,
  clearKey,
  getKey,
  getSettings,
  keyStatus,
  readCache,
  setKey,
  setSettings,
  writeCache,
} from './storage.js';

const CONCURRENCY = 4;
const RETRY_COUNT = 2;
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 8000;

const REQUEST_TYPES = new Set<string>([
  'CLASSIFY',
  'DEEP_CLASSIFY',
  'GET_STATUS',
  'CONTENT_READY',
  'GET_SETTINGS',
  'SET_SETTINGS',
  'SET_KEY',
  'CLEAR_KEY',
  'KEY_STATUS',
  'TEST_CONNECTION',
  'CLEAR_CACHE',
  'CACHE_STATS',
]);

let inFlight = 0;
let classifiedCount = 0;
let errorCount = 0;
let estimatedCostUsd = 0;
let cachedCount = 0;

function currentStats(): StatusStats {
  return {
    classified: classifiedCount,
    inFlight,
    errors: errorCount,
    estimatedCostUsd,
    cached: cachedCount,
  };
}

async function broadcastToGmailTabs(message: BackgroundToContent | BackgroundToUi): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined
          ? Promise.resolve()
          : chrome.tabs.sendMessage(tab.id, message).catch(() => undefined),
      ),
    );
  } catch {
    // tabs permission quirks in some contexts; status is best-effort.
  }
}

function broadcastStatus(): void {
  void broadcastToGmailTabs({ type: 'STATUS', stats: currentStats() });
}

function dedupeEmails(emails: EmailMetadata[]): EmailMetadata[] {
  const seen = new Set<string>();
  const out: EmailMetadata[] = [];
  for (const email of emails) {
    if (!email || !email.hash || seen.has(email.hash)) continue;
    seen.add(email.hash);
    out.push(email);
  }
  return out;
}

function getCached(cache: CacheState, hash: string) {
  return cacheGet(cache, `${hash}:deep`) ?? cacheGet(cache, hash);
}

interface ClassifyOutcome {
  classification: Classification;
  costUsd: number;
}

async function classifyOne(
  email: EmailMetadata,
  settings: Settings,
  apiKey: string,
  deep: boolean,
  body: string | undefined,
): Promise<ClassifyOutcome> {
  const provider = createProvider(settings.provider);
  const state = buildJevState(email, settings, body);
  const questions = buildQuestions(settings);

  const result = await withRetry(() => provider.callJev(state, questions, { apiKey }), {
    retries: RETRY_COUNT,
    baseDelayMs: RETRY_BASE_MS,
    maxDelayMs: RETRY_MAX_MS,
    isRetryable: (error) => error instanceof JevError && error.retryable,
    onRetry: ({ delayMs, error }) => {
      const friendly = error instanceof JevError ? error.friendly : 'Transient error.';
      void broadcastToGmailTabs({
        type: 'WARNING',
        message: `${friendly} Retrying in ${Math.round(delayMs)}ms.`,
      });
    },
  });

  const classification = classificationFromResponse(email, result.response, settings, {
    provider: settings.provider,
    deep,
  });
  const costUsd = result.costUsd ?? costFromResponse(result.response) ?? 0;
  return { classification, costUsd };
}

async function handleClassify(
  requestId: string,
  emails: EmailMetadata[],
  deep: { body: string } | undefined,
): Promise<BackgroundToContent> {
  const settings = await getSettings();
  const errors: ErrorInfo[] = [];
  if (!settings.enabled) {
    return { type: 'CLASSIFY_RESULT', requestId, results: [], errors };
  }

  const unique = dedupeEmails(emails);
  const cache = await readCache(settings);
  cache.meta.fingerprint = fingerprintSettings(settings);
  cachedCount = Object.keys(cache.entries).length;

  const results: Classification[] = [];
  const pending: EmailMetadata[] = [];

  for (const email of unique) {
    const hit = getCached(cache, email.hash);
    if (hit) {
      results.push({ ...hit.classification, emailId: email.id });
    } else {
      pending.push(email);
    }
  }

  if (pending.length > 0) {
    const apiKey = await getKey(settings.provider);
    if (!apiKey) {
      for (const email of pending) {
        errors.push({
          emailId: email.id,
          hash: email.hash,
          code: 'no_key',
          message: new JevError('no_key', '').friendly,
        });
      }
      errorCount += pending.length;
    } else {
      await runWithConcurrency(pending, CONCURRENCY, async (email) => {
        inFlight++;
        broadcastStatus();
        try {
          const outcome = await classifyOne(email, settings, apiKey, Boolean(deep), deep?.body);
          results.push(outcome.classification);
          classifiedCount++;
          estimatedCostUsd += outcome.costUsd;
          cacheSet(cache, deep ? `${email.hash}:deep` : email.hash, outcome.classification);
        } catch (error) {
          const jev = error instanceof JevError ? error : new JevError('unknown', String(error));
          errorCount++;
          errors.push({ emailId: email.id, hash: email.hash, code: jev.code, message: jev.friendly });
        } finally {
          inFlight--;
          broadcastStatus();
        }
      });
      await writeCache(cache);
      cachedCount = Object.keys(cache.entries).length;
    }
  }

  broadcastStatus();
  return { type: 'CLASSIFY_RESULT', requestId, results, errors };
}

async function handle(message: Record<string, unknown>): Promise<BackgroundToUi | BackgroundToContent | undefined> {
  switch (message.type) {
    case 'CLASSIFY':
      return handleClassify(
        String(message.requestId ?? ''),
        (message.emails as EmailMetadata[]) ?? [],
        undefined,
      );
    case 'DEEP_CLASSIFY':
      return handleClassify(
        String(message.requestId ?? ''),
        [message.email as EmailMetadata],
        { body: String(message.body ?? '') },
      );
    case 'GET_STATUS':
    case 'CONTENT_READY':
      return { type: 'STATUS', stats: currentStats() };
    case 'GET_SETTINGS':
      return { type: 'SETTINGS', settings: await getSettings() };
    case 'SET_SETTINGS': {
      const settings = await setSettings((message.patch as Partial<Settings>) ?? {});
      void broadcastToGmailTabs({ type: 'SETTINGS', settings });
      return { type: 'SETTINGS', settings };
    }
    case 'SET_KEY': {
      const provider = message.provider as ProviderId;
      const apiKey = String(message.apiKey ?? '').trim();
      if (!apiKey) return { type: 'ERROR', message: 'API key is empty.' };
      await setKey(provider, apiKey);
      return { type: 'KEY_STATUS', keys: await keyStatus() };
    }
    case 'CLEAR_KEY': {
      await clearKey(message.provider as ProviderId);
      return { type: 'KEY_STATUS', keys: await keyStatus() };
    }
    case 'KEY_STATUS':
      return { type: 'KEY_STATUS', keys: await keyStatus() };
    case 'TEST_CONNECTION': {
      const providerId = message.provider as ProviderId;
      const typed = String(message.apiKey ?? '').trim();
      const apiKey = typed.length > 0 ? typed : await getKey(providerId);
      if (!apiKey) {
        return {
          type: 'TEST_RESULT',
          ok: false,
          message: 'No API key provided or saved for this provider.',
          latencyMs: 0,
        };
      }
      const result = await createProvider(providerId).testConnection(apiKey);
      return {
        type: 'TEST_RESULT',
        ok: result.ok,
        message: result.message,
        latencyMs: result.latencyMs,
        ...(result.model ? { model: result.model } : {}),
      };
    }
    case 'CLEAR_CACHE': {
      await clearCache();
      cachedCount = 0;
      return { type: 'CACHE_STATS', count: 0, bytes: 0 };
    }
    case 'CACHE_STATS': {
      const stats = await cacheStats();
      cachedCount = stats.count;
      return { type: 'CACHE_STATS', count: stats.count, bytes: stats.bytes };
    }
    default:
      return undefined;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getSettings().then((settings) => chrome.storage.local.set({ settings }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | undefined)?.type;
  if (!type || !REQUEST_TYPES.has(type)) return undefined;
  handle(message as Record<string, unknown>).then(sendResponse, (error) => {
    const jev = error instanceof JevError ? error : new JevError('unknown', String(error));
    sendResponse({ type: 'ERROR', message: jev.friendly } satisfies BackgroundToUi);
  });
  return true; // keep the channel open for the async response
});
