/**
 * Popup UI: enable toggle, provider/key management, connection test, cache.
 * Plain DOM only; all user data is written with textContent / input.value.
 */
import type {
  BackgroundToUi,
  ProviderId,
  Settings,
  UiToBackground,
} from '../shared/types.js';
import { PROVIDERS } from '../shared/defaults.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const enabledEl = el<HTMLInputElement>('enabled');
const providerEl = el<HTMLSelectElement>('provider');
const apiKeyEl = el<HTMLInputElement>('api-key');
const saveKeyBtn = el<HTMLButtonElement>('save-key');
const removeKeyBtn = el<HTMLButtonElement>('remove-key');
const keyStatusEl = el<HTMLSpanElement>('key-status');
const testBtn = el<HTMLButtonElement>('test');
const testResultEl = el<HTMLDivElement>('test-result');
const openOptionsBtn = el<HTMLButtonElement>('open-options');
const cacheLineEl = el<HTMLSpanElement>('cache-line');
const clearCacheBtn = el<HTMLButtonElement>('clear-cache');

let settings: Settings | null = null;
let keys: Partial<Record<ProviderId, string>> = {};

function send(message: UiToBackground): Promise<BackgroundToUi> {
  return chrome.runtime.sendMessage(message) as Promise<BackgroundToUi>;
}

function currentProvider(): ProviderId {
  return providerEl.value as ProviderId;
}

function renderProviderOptions(): void {
  providerEl.replaceChildren();
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    providerEl.append(option);
  }
}

function renderKeyStatus(): void {
  const last4 = keys[currentProvider()];
  keyStatusEl.textContent = last4 ? `Saved: ****${last4}` : 'No key saved';
}

function renderCache(count: number, bytes: number): void {
  const kb = bytes > 0 ? ` (${(bytes / 1024).toFixed(1)} KB)` : '';
  cacheLineEl.textContent = `Cache: ${count} entries${kb}`;
}

function renderSettings(next: Settings): void {
  settings = next;
  enabledEl.checked = next.enabled;
  providerEl.value = next.provider;
  renderKeyStatus();
}

function setTestResult(text: string, ok: boolean | null): void {
  testResultEl.textContent = text;
  testResultEl.classList.toggle('ok', ok === true);
  testResultEl.classList.toggle('err', ok === false);
}

async function loadAll(): Promise<void> {
  const [settingsReply, keyReply, cacheReply] = await Promise.all([
    send({ type: 'GET_SETTINGS' }),
    send({ type: 'KEY_STATUS' }),
    send({ type: 'CACHE_STATS' }),
  ]);
  if (settingsReply.type === 'SETTINGS') renderSettings(settingsReply.settings);
  if (keyReply.type === 'KEY_STATUS') {
    keys = keyReply.keys;
    renderKeyStatus();
  }
  if (cacheReply.type === 'CACHE_STATS') renderCache(cacheReply.count, cacheReply.bytes);
}

enabledEl.addEventListener('change', () => {
  void send({ type: 'SET_SETTINGS', patch: { enabled: enabledEl.checked } }).then((reply) => {
    if (reply.type === 'SETTINGS') renderSettings(reply.settings);
  });
});

providerEl.addEventListener('change', () => {
  renderKeyStatus();
  setTestResult('', null);
  void send({ type: 'SET_SETTINGS', patch: { provider: currentProvider() } }).then((reply) => {
    if (reply.type === 'SETTINGS') renderSettings(reply.settings);
  });
});

saveKeyBtn.addEventListener('click', () => {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) {
    keyStatusEl.textContent = 'Enter a key first';
    return;
  }
  void send({ type: 'SET_KEY', provider: currentProvider(), apiKey }).then((reply) => {
    if (reply.type === 'KEY_STATUS') {
      keys = reply.keys;
      apiKeyEl.value = '';
      renderKeyStatus();
    } else if (reply.type === 'ERROR') {
      keyStatusEl.textContent = reply.message;
    }
  });
});

removeKeyBtn.addEventListener('click', () => {
  void send({ type: 'CLEAR_KEY', provider: currentProvider() }).then((reply) => {
    if (reply.type === 'KEY_STATUS') {
      keys = reply.keys;
      renderKeyStatus();
    }
  });
});

testBtn.addEventListener('click', () => {
  const typed = apiKeyEl.value.trim();
  testBtn.disabled = true;
  setTestResult('Testing...', null);
  const message: UiToBackground = typed
    ? { type: 'TEST_CONNECTION', provider: currentProvider(), apiKey: typed }
    : { type: 'TEST_CONNECTION', provider: currentProvider() };
  void send(message)
    .then((reply) => {
      if (reply.type !== 'TEST_RESULT') {
        setTestResult(reply.type === 'ERROR' ? reply.message : 'Unexpected reply', false);
        return;
      }
      const parts = [reply.ok ? 'OK' : 'Failed', reply.message];
      if (reply.model) parts.push(`model: ${reply.model}`);
      if (typeof reply.latencyMs === 'number') parts.push(`${reply.latencyMs} ms`);
      if (typeof reply.costUsd === 'number') parts.push(`~$${reply.costUsd.toFixed(6)}`);
      setTestResult(parts.join(' | '), reply.ok);
    })
    .catch((err: unknown) => {
      setTestResult(err instanceof Error ? err.message : String(err), false);
    })
    .finally(() => {
      testBtn.disabled = false;
    });
});

clearCacheBtn.addEventListener('click', () => {
  void send({ type: 'CLEAR_CACHE' }).then((reply) => {
    if (reply.type === 'CACHE_STATS') renderCache(reply.count, reply.bytes);
  });
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

renderProviderOptions();
void loadAll();

// Keep the settings reference meaningful for future UI additions.
void settings;
