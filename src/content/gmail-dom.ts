/**
 * ALL Gmail-specific selectors live here. Gmail's markup is undocumented and
 * changes without notice, so keep every selector in this one file and update
 * docs/gmail-dom.md alongside it. Everything else works off the extracted data.
 *
 * Fallbacks are ordered most-specific first. When a selector stops matching,
 * readRow() returns null for that row and the caller shows a status-bar warning
 * once, instead of throwing.
 */
import type { RawRowFields } from '../shared/metadata.js';

export const SELECTORS = {
  /** Message list rows. `tr.zA` is the long-standing row class. */
  row: ['tr.zA'],
  /** The list container, used to scope the MutationObserver. */
  list: ['table.F.cf.zt', 'div[role="main"] table', 'div[gh="tl"]'],
  /** Element carrying the sender's email in its `email` attribute. */
  sender: ['span[email]', '.yW span[email]', '.yX span[email]'],
  /** Subject line. */
  subject: ['.bog', '.y6 span.bog', 'span.bog'],
  /** One-line preview. */
  snippet: ['.y2', 'span.y2'],
  /** Date cell; its span often carries a full timestamp in `title`. */
  date: ['.xW span', 'td.xW span', '.xW'],
  /** Opened message body (deep mode only). */
  body: ['div.a3s'],
} as const;

function firstMatch(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

function allMatches(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll(selector));
    if (found.length > 0) return found;
  }
  return [];
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Rows currently rendered in the Gmail list. Empty when not on the list. */
export function getRows(root: ParentNode = document): HTMLElement[] {
  return allMatches(root, SELECTORS.row).filter((el): el is HTMLElement => el instanceof HTMLElement);
}

export function getListRoot(): HTMLElement | null {
  const found = allMatches(document, SELECTORS.list)[0];
  return found instanceof HTMLElement ? found : null;
}

export function isUnread(row: HTMLElement): boolean {
  return row.classList.contains('zE') || row.querySelector('.zE') !== null;
}

export function readRow(row: HTMLElement): RawRowFields | null {
  const senderEl = firstMatch(row, SELECTORS.sender);
  const subjectEl = firstMatch(row, SELECTORS.subject);
  const snippetEl = firstMatch(row, SELECTORS.snippet);
  const dateEl = firstMatch(row, SELECTORS.date);

  const senderEmail = senderEl?.getAttribute('email') ?? '';
  const senderName = text(senderEl);
  const subject = text(subjectEl);
  const snippet = text(snippetEl);
  const date = dateEl?.getAttribute('title') ?? text(dateEl);

  if (!senderEmail && !senderName && !subject) return null;

  return {
    senderName,
    senderEmail,
    subject,
    snippet,
    date,
    unread: isUnread(row),
  };
}

/** Gmail's thread id for the row, when present. Used as a stable element key. */
export function rowThreadId(row: HTMLElement): string | undefined {
  return (
    row.getAttribute('data-legacy-thread-id') ??
    row.getAttribute('data-thread-id') ??
    row.id ??
    undefined
  );
}

/** Text of the opened message body (the last `div.a3s`), for opt-in deep mode. */
export function readOpenBody(root: ParentNode = document): string | null {
  const bodies = allMatches(root, SELECTORS.body);
  if (bodies.length === 0) return null;
  return text(bodies[bodies.length - 1]);
}

/** True when Gmail's list shell exists but no rows matched — a selector break. */
export function selectorsLookBroken(): boolean {
  const shell = document.querySelector('div[role="main"]');
  return shell !== null && getRows().length === 0;
}
