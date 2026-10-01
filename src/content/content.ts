/**
 * Content script: reads the Gmail list, asks the service worker to classify,
 * and injects chips + a status bar. It makes NO network calls and never touches
 * the API key. All Gmail selectors live in gmail-dom.ts.
 */
import { CATEGORY_COLORS, UNCERTAIN_ID } from '../shared/defaults.js';
import { formatUsd } from '../shared/cost.js';
import { makeEmailMetadata } from '../shared/metadata.js';
import type {
  BackgroundToContent,
  BackgroundToUi,
  Classification,
  ContentToBackground,
  EmailMetadata,
  Settings,
  StatusStats,
  UiToBackground,
} from '../shared/types.js';
import {
  getListRoot,
  getRows,
  readOpenBody,
  readRow,
  rowThreadId,
  selectorsLookBroken,
} from './gmail-dom.js';

type AnyReply = BackgroundToContent | BackgroundToUi;
type AnyMessage = ContentToBackground | UiToBackground;

const SCAN_THROTTLE_MS = 400;
const CLASSIFY_DEBOUNCE_MS = 500;
const MAX_ROWS_PER_BATCH = 25;
const BROKEN_WARN_AFTER = 4;
const DEEP_CLICK_DELAY_MS = 600;

let settings: Settings | null = null;
let observer: MutationObserver | null = null;
let scanTimer: number | null = null;
let classifyTimer: number | null = null;
let statusEl: HTMLElement | null = null;
let statusText: HTMLElement | null = null;

const pendingEmails = new Map<string, EmailMetadata>();
const classifications = new Map<string, Classification>();
const rowByHash = new Map<string, Set<HTMLElement>>();
const hashByRow = new WeakMap<HTMLElement, string>();
const deepAttempted = new Set<string>();

let brokenStreak = 0;
let brokenWarned = false;
let requestInFlight = false;

let stats: StatusStats = {
  classified: 0,
  inFlight: 0,
  errors: 0,
  estimatedCostUsd: 0,
  cached: 0,
};

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function send(message: AnyMessage): Promise<AnyReply | undefined> {
  try {
    return chrome.runtime.sendMessage(message).then(
      (reply) => reply as AnyReply | undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve(undefined);
  }
}

/* ----------------------------- chip rendering ---------------------------- */

function categoryColor(classification: Classification): string {
  if (classification.uncertain || classification.categoryId === UNCERTAIN_ID) return '#9ca3af';
  const categories = settings?.categories ?? [];
  const index = categories.findIndex((c) => c.id === classification.categoryId);
  if (index >= 0) {
    const explicit = categories[index].color;
    if (explicit) return explicit;
    return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
  }
  return '#6b7280';
}

function chipContainer(row: HTMLElement): HTMLElement | null {
  const anchor = row.querySelector('.bog') ?? row.querySelector('.y6');
  const parent = anchor?.parentElement ?? null;
  return parent instanceof HTMLElement ? parent : null;
}

function paintChip(chip: HTMLElement, classification: Classification): void {
  chip.textContent = '';
  const dot = document.createElement('span');
  dot.className = `jvc-dot jvc-priority-${classification.priority}`;
  dot.title = `Priority: ${classification.priority}`;
  const label = document.createElement('span');
  label.className = 'jvc-label';
  label.textContent = classification.uncertain ? 'Uncertain' : classification.categoryName;
  chip.append(dot, label);
  chip.classList.toggle('jvc-uncertain', classification.uncertain);
  chip.style.setProperty('--jvc-color', categoryColor(classification));
  chip.dataset.jvcHash = classification.hash;
  chip.title = [
    `Jev: ${classification.categoryName}`,
    `confidence ${(classification.categoryConfidence * 100).toFixed(0)}%`,
    `priority ${classification.priority}`,
    `spam ${(classification.spamProbability * 100).toFixed(0)}%`,
    `needs reply ${(classification.needsReplyProbability * 100).toFixed(0)}%`,
    classification.deep ? 'deep pass' : 'metadata pass',
  ].join(' · ');
}

function renderRowChip(row: HTMLElement, classification: Classification | undefined): void {
  let chip = row.querySelector<HTMLElement>('.jvc-chip');
  if (!classification) {
    chip?.remove();
    return;
  }
  if (!chip) {
    const container = chipContainer(row);
    if (!container) return;
    chip = document.createElement('span');
    chip.className = 'jvc-chip';
    container.appendChild(chip);
  }
  paintChip(chip, classification);
}

/* ------------------------------ status bar ------------------------------- */

function ensureStatusBar(): void {
  if (statusEl) return;
  statusEl = document.createElement('div');
  statusEl.className = 'jvc-status';
  statusText = document.createElement('span');
  statusText.className = 'jvc-status-text';
  statusEl.appendChild(statusText);
  document.body.appendChild(statusEl);
}

function renderStatus(): void {
  ensureStatusBar();
  if (!statusEl || !statusText) return;
  if (!settings?.enabled) {
    statusEl.style.display = 'none';
    return;
  }
  statusEl.style.display = '';
  statusText.textContent =
    `Jev · ${stats.classified} classified · ${stats.inFlight} in flight · ` +
    `${stats.errors} errors · ~${formatUsd(stats.estimatedCostUsd)}`;
}

function showWarning(message: string): void {
  ensureStatusBar();
  if (!statusEl) return;
  const warn = document.createElement('span');
  warn.className = 'jvc-warn';
  warn.textContent = message;
  statusEl.appendChild(warn);
  window.setTimeout(() => warn.remove(), 8000);
}

/* ------------------------------- scanning -------------------------------- */

function scheduleScan(): void {
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_THROTTLE_MS);
}

function scan(): void {
  if (!settings) return;
  if (!settings.enabled) {
    clearVisuals();
    return;
  }

  const rows = getRows();
  if (rows.length === 0) {
    if (selectorsLookBroken()) {
      brokenStreak++;
      if (brokenStreak >= BROKEN_WARN_AFTER && !brokenWarned) {
        brokenWarned = true;
        showWarning('Gmail markup not recognised; chips are paused. See docs/gmail-dom.md.');
      }
    }
    return;
  }
  brokenStreak = 0;

  rowByHash.clear();
  const toClassify: EmailMetadata[] = [];

  for (const row of rows) {
    const raw = readRow(row);
    if (!raw) continue;
    if (settings.classifyUnreadOnly && !raw.unread) continue;
    const meta = makeEmailMetadata(raw, rowThreadId(row));
    hashByRow.set(row, meta.hash);
    let set = rowByHash.get(meta.hash);
    if (!set) {
      set = new Set();
      rowByHash.set(meta.hash, set);
    }
    set.add(row);
    if (!classifications.has(meta.hash) && !pendingEmails.has(meta.hash)) {
      toClassify.push(meta);
      pendingEmails.set(meta.hash, meta);
    }
  }

  for (const row of rows) {
    const hash = hashByRow.get(row);
    renderRowChip(row, hash ? classifications.get(hash) : undefined);
  }

  if (toClassify.length > 0) scheduleClassify();
  applyGrouping();
  renderStatus();
}

function scheduleClassify(): void {
  if (classifyTimer !== null) return;
  classifyTimer = window.setTimeout(() => {
    classifyTimer = null;
    void flushClassify();
  }, CLASSIFY_DEBOUNCE_MS);
}

async function flushClassify(): Promise<void> {
  if (requestInFlight) {
    scheduleClassify();
    return;
  }
  const batch = Array.from(pendingEmails.values()).slice(0, MAX_ROWS_PER_BATCH);
  if (batch.length === 0) return;

  for (const email of batch) pendingEmails.delete(email.hash);
  requestInFlight = true;
  stats.inFlight += batch.length;
  renderStatus();

  const reply = await send({ type: 'CLASSIFY', requestId: randomId(), emails: batch });
  requestInFlight = false;
  stats.inFlight = Math.max(0, stats.inFlight - batch.length);

  if (reply && reply.type === 'CLASSIFY_RESULT') {
    for (const classification of reply.results) classifications.set(classification.hash, classification);
    stats.classified = classifications.size;
    if (reply.errors.length > 0) {
      stats.errors += reply.errors.length;
      showWarning(reply.errors[0].message);
    }
    for (const [hash, elements] of rowByHash) {
      const classification = classifications.get(hash);
      for (const element of elements) renderRowChip(element, classification);
    }
    applyGrouping();
  } else {
    for (const email of batch) pendingEmails.set(email.hash, email);
  }

  renderStatus();
  if (pendingEmails.size > 0) scheduleClassify();
}

/* --------------------- on-screen-only priority grouping ------------------ */

function priorityRank(classification: Classification | undefined): number {
  if (!classification || classification.uncertain) return 3;
  if (classification.priority === 'high') return 0;
  if (classification.priority === 'medium') return 1;
  return 2;
}

function applyGrouping(): void {
  const rows = getRows();
  if (!settings?.enabled || !settings.groupByPriority) {
    for (const row of rows) {
      row.style.transform = '';
      row.style.transition = '';
    }
    return;
  }
  try {
    const items = rows.map((row, index) => ({ row, index, hash: hashByRow.get(row) }));
    const heights = items.map((item) => item.row.getBoundingClientRect().height);
    const order = [...items].sort((a, b) => {
      const rankA = priorityRank(a.hash ? classifications.get(a.hash) : undefined);
      const rankB = priorityRank(b.hash ? classifications.get(b.hash) : undefined);
      return rankA - rankB || a.index - b.index;
    });

    const originalTop = new Map<number, number>();
    let acc = 0;
    items.forEach((_item, i) => {
      originalTop.set(i, acc);
      acc += heights[i];
    });
    const newTop = new Map<number, number>();
    let acc2 = 0;
    for (const item of order) {
      newTop.set(item.index, acc2);
      acc2 += heights[item.index];
    }
    items.forEach((item, i) => {
      const offset = (newTop.get(i) ?? 0) - (originalTop.get(i) ?? 0);
      item.row.style.transition = 'transform .18s ease';
      item.row.style.transform = offset ? `translateY(${offset}px)` : '';
    });
  } catch {
    // Grouping is cosmetic; never let it break the page.
  }
}

/* --------------------------- opt-in deep mode ---------------------------- */

function onDocumentClick(event: MouseEvent): void {
  if (!settings?.enabled || !settings.deepMode) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const row = target?.closest('tr.zA');
  if (!(row instanceof HTMLElement)) return;
  const hash = hashByRow.get(row);
  if (!hash) return;
  const current = classifications.get(hash);
  if (!current || !current.uncertain || deepAttempted.has(hash)) return;
  deepAttempted.add(hash);
  window.setTimeout(() => void runDeepPass(row, hash), DEEP_CLICK_DELAY_MS);
}

async function runDeepPass(row: HTMLElement, hash: string): Promise<void> {
  const body = readOpenBody();
  const raw = readRow(row);
  if (!body || !raw) return;
  const meta = makeEmailMetadata(raw, rowThreadId(row));
  const reply = await send({ type: 'DEEP_CLASSIFY', requestId: randomId(), email: meta, body });
  if (reply && reply.type === 'CLASSIFY_RESULT' && reply.results[0]) {
    const classification = reply.results[0];
    classifications.set(classification.hash, classification);
    const elements = rowByHash.get(hash);
    if (elements) for (const element of elements) renderRowChip(element, classification);
  }
}

/* ------------------------------ lifecycle -------------------------------- */

function clearVisuals(): void {
  for (const chip of Array.from(document.querySelectorAll('.jvc-chip'))) chip.remove();
  for (const row of getRows()) {
    row.style.transform = '';
    row.style.transition = '';
  }
  if (statusEl) statusEl.style.display = 'none';
}

function onRuntimeMessage(message: AnyReply): void {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'STATUS':
      stats = { ...stats, ...message.stats, classified: Math.max(stats.classified, message.stats.classified) };
      renderStatus();
      break;
    case 'WARNING':
      showWarning(message.message);
      break;
    case 'SETTINGS':
      settings = message.settings;
      classifications.clear();
      pendingEmails.clear();
      deepAttempted.clear();
      brokenWarned = false;
      scheduleScan();
      break;
    default:
      break;
  }
}

function installObserver(): void {
  const root = getListRoot() ?? document.body;
  observer = new MutationObserver(() => scheduleScan());
  observer.observe(root, { childList: true, subtree: true });
}

async function init(): Promise<void> {
  const reply = await send({ type: 'GET_SETTINGS' });
  if (reply && reply.type === 'SETTINGS') settings = reply.settings;
  ensureStatusBar();
  installObserver();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleScan();
  });
  scheduleScan();
}

void init();

// Keep references used only via DOM events from being tree-shaken away.
void observer;
