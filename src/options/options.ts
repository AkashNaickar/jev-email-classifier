/**
 * Options UI: category editor, thresholds, behaviour toggles, cache.
 * Plain DOM only; all user data is written with textContent / input.value.
 */
import type {
  BackgroundToUi,
  Category,
  Settings,
  UiToBackground,
} from '../shared/types.js';
import {
  CATEGORY_COLORS,
  MAX_CATEGORIES,
  PRIORITY_LEVELS,
} from '../shared/defaults.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const categoriesEl = el<HTMLDivElement>('categories');
const catCountEl = el<HTMLSpanElement>('cat-count');
const addCategoryBtn = el<HTMLButtonElement>('add-category');
const confidenceEl = el<HTMLInputElement>('confidence');
const confidenceReadout = el<HTMLSpanElement>('confidence-readout');
const priorityLowEl = el<HTMLInputElement>('priority-low');
const priorityLowReadout = el<HTMLSpanElement>('priority-low-readout');
const priorityHighEl = el<HTMLInputElement>('priority-high');
const priorityHighReadout = el<HTMLSpanElement>('priority-high-readout');
const priorityLegendEl = el<HTMLParagraphElement>('priority-legend');
const privacyModeEl = el<HTMLInputElement>('privacy-mode');
const deepModeEl = el<HTMLInputElement>('deep-mode');
const groupByPriorityEl = el<HTMLInputElement>('group-by-priority');
const classifyUnreadOnlyEl = el<HTMLInputElement>('classify-unread-only');
const cacheLineEl = el<HTMLSpanElement>('cache-line');
const clearCacheBtn = el<HTMLButtonElement>('clear-cache');
const errorsEl = el<HTMLDivElement>('errors');
const saveBtn = el<HTMLButtonElement>('save');
const savedEl = el<HTMLSpanElement>('saved');

let settings: Settings | null = null;
let maxCategories = MAX_CATEGORIES;
let savedTimer: number | undefined;

function send(message: UiToBackground): Promise<BackgroundToUi> {
  return chrome.runtime.sendMessage(message) as Promise<BackgroundToUi>;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'category';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

function makeId(name: string, existing: Category[]): string {
  const base = slugify(name);
  let id = `${base}-${randomSuffix()}`;
  while (existing.some((c) => c.id === id)) id = `${base}-${randomSuffix()}`;
  return id;
}

function renderCache(count: number, bytes: number): void {
  const kb = bytes > 0 ? ` (${(bytes / 1024).toFixed(1)} KB)` : '';
  cacheLineEl.textContent = `Cache: ${count} entries${kb}`;
}

function updateCount(): void {
  const rows = categoriesEl.querySelectorAll('.cat-row').length;
  catCountEl.textContent = `${rows} / ${maxCategories}`;
  addCategoryBtn.disabled = rows >= maxCategories;
}

function makeCategoryRow(category: Category, index: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'card cat-row';
  row.dataset.id = category.id;

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = category.color ?? CATEGORY_COLORS[index % CATEGORY_COLORS.length];
  swatch.title = category.color ? 'Explicit colour' : 'Derived from position';

  const fields = document.createElement('div');
  fields.className = 'cat-fields';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cat-name';
  nameInput.placeholder = 'Name';
  nameInput.value = category.name;

  const descInput = document.createElement('textarea');
  descInput.className = 'cat-desc';
  descInput.placeholder = 'Description sent to the provider';
  descInput.value = category.description;

  fields.append(nameInput, descInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateCount();
  });

  row.append(swatch, fields, removeBtn);
  return row;
}

function renderCategories(categories: Category[]): void {
  categoriesEl.replaceChildren();
  categories.forEach((category, index) => {
    categoriesEl.append(makeCategoryRow(category, index));
  });
  updateCount();
}

function readCategories(): Category[] {
  const rows = categoriesEl.querySelectorAll<HTMLDivElement>('.cat-row');
  const result: Category[] = [];
  rows.forEach((row) => {
    const name = row.querySelector<HTMLInputElement>('.cat-name')?.value.trim() ?? '';
    const description = row.querySelector<HTMLTextAreaElement>('.cat-desc')?.value.trim() ?? '';
    const id = row.dataset.id ?? '';
    result.push({ id, name, description });
  });
  return result;
}

function setReadout(target: HTMLElement, value: number): void {
  target.textContent = value.toFixed(2);
}

function renderSettings(next: Settings): void {
  settings = next;
  maxCategories = next.maxCategories || MAX_CATEGORIES;
  renderCategories(next.categories);
  confidenceEl.value = String(next.confidenceThreshold);
  setReadout(confidenceReadout, next.confidenceThreshold);
  priorityLowEl.value = String(next.priorityLowThreshold);
  setReadout(priorityLowReadout, next.priorityLowThreshold);
  priorityHighEl.value = String(next.priorityHighThreshold);
  setReadout(priorityHighReadout, next.priorityHighThreshold);
  privacyModeEl.checked = next.privacyMode;
  deepModeEl.checked = next.deepMode;
  groupByPriorityEl.checked = next.groupByPriority;
  classifyUnreadOnlyEl.checked = next.classifyUnreadOnly;
}

function showErrors(messages: string[]): void {
  errorsEl.textContent = messages.join('\n');
}

function showSaved(): void {
  savedEl.classList.add('show');
  if (savedTimer !== undefined) window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => savedEl.classList.remove('show'), 1600);
}

function validate(categories: Category[], low: number, high: number): string[] {
  const errors: string[] = [];
  if (categories.length < 1) errors.push('Add at least one category.');
  categories.forEach((category, index) => {
    if (!category.name) errors.push(`Category ${index + 1}: name is required.`);
    if (!category.description) errors.push(`Category ${index + 1}: description is required.`);
  });
  const ids = categories.map((c) => c.id);
  if (new Set(ids).size !== ids.length) errors.push('Category ids must be unique.');
  if (low >= high) errors.push('Priority low threshold must be below the high threshold.');
  return errors;
}

addCategoryBtn.addEventListener('click', () => {
  const rows = categoriesEl.querySelectorAll('.cat-row').length;
  if (rows >= maxCategories) return;
  const existing = readCategories();
  const category: Category = { id: makeId('new category', existing), name: '', description: '' };
  categoriesEl.append(makeCategoryRow(category, rows));
  updateCount();
});

confidenceEl.addEventListener('input', () => {
  setReadout(confidenceReadout, Number(confidenceEl.value));
});
priorityLowEl.addEventListener('input', () => {
  setReadout(priorityLowReadout, Number(priorityLowEl.value));
});
priorityHighEl.addEventListener('input', () => {
  setReadout(priorityHighReadout, Number(priorityHighEl.value));
});

clearCacheBtn.addEventListener('click', () => {
  void send({ type: 'CLEAR_CACHE' }).then((reply) => {
    if (reply.type === 'CACHE_STATS') renderCache(reply.count, reply.bytes);
  });
});

saveBtn.addEventListener('click', () => {
  if (!settings) return;
  const categories = readCategories();
  const low = Number(priorityLowEl.value);
  const high = Number(priorityHighEl.value);
  const errors = validate(categories, low, high);
  if (errors.length > 0) {
    showErrors(errors);
    return;
  }
  showErrors([]);
  const patch: Partial<Settings> = {
    categories,
    confidenceThreshold: Number(confidenceEl.value),
    priorityLowThreshold: low,
    priorityHighThreshold: high,
    privacyMode: privacyModeEl.checked,
    deepMode: deepModeEl.checked,
    groupByPriority: groupByPriorityEl.checked,
    classifyUnreadOnly: classifyUnreadOnlyEl.checked,
  };
  void send({ type: 'SET_SETTINGS', patch }).then((reply) => {
    if (reply.type === 'SETTINGS') {
      renderSettings(reply.settings);
      showSaved();
    } else if (reply.type === 'ERROR') {
      showErrors([reply.message]);
    }
  });
});

async function loadAll(): Promise<void> {
  const [settingsReply, cacheReply] = await Promise.all([
    send({ type: 'GET_SETTINGS' }),
    send({ type: 'CACHE_STATS' }),
  ]);
  if (settingsReply.type === 'SETTINGS') renderSettings(settingsReply.settings);
  if (cacheReply.type === 'CACHE_STATS') renderCache(cacheReply.count, cacheReply.bytes);
}

priorityLegendEl.textContent = PRIORITY_LEVELS.join(' ');
void loadAll();
