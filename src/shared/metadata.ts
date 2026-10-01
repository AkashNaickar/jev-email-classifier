import type { EmailMetadata, Settings } from './types.js';
import { normalizeWhitespace, stableHash, truncate } from './util.js';

/** Raw fields the content script scrapes from one Gmail row. */
export interface RawRowFields {
  senderName: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

/** Patterns that begin quoted replies / signatures / footers. */
const QUOTE_START = [
  /^\s*On .+wrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}/i,
  /^\s*From:\s.+/i,
  /^\s*_{5,}\s*$/,
  /^\s*Sent from my /i,
  /^\s*Get Outlook for /i,
];

const SIGNATURE_MARKER = /^--\s*$/;
const UNSUBSCRIBE = /(unsubscribe|manage (my )?preferences|view (this email )?in browser|email preferences)/i;

/**
 * Remove quoted replies, signatures and boilerplate footers from a snippet.
 * Gmail snippets are one line, but the same routine protects deep-mode bodies.
 */
export function cleanSnippet(input: string): string {
  if (!input) return '';
  const lines = input.split(/\r?\n/);
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      kept.push('');
      continue;
    }
    if (line.startsWith('>')) break;
    if (SIGNATURE_MARKER.test(line)) break;
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (UNSUBSCRIBE.test(line) && kept.length > 0) break;
    kept.push(line);
  }
  return normalizeWhitespace(kept.join(' '));
}

export function redactEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return 'redacted';
  return `***@${address.slice(at + 1)}`;
}

/** Cache key: stable across renders for the same sender+subject+date. */
export function computeEmailHash(senderEmail: string, subject: string, date: string): string {
  return stableHash(`${senderEmail}\u0000${subject}\u0000${date}`);
}

export function makeEmailMetadata(raw: RawRowFields, idHint?: string): EmailMetadata {
  const senderEmail = normalizeWhitespace(raw.senderEmail).toLowerCase();
  const subject = normalizeWhitespace(raw.subject);
  const date = normalizeWhitespace(raw.date);
  const hash = computeEmailHash(senderEmail, subject, date);
  return {
    id: idHint && idHint.length > 0 ? idHint : hash,
    hash,
    senderName: normalizeWhitespace(raw.senderName),
    senderEmail,
    subject,
    snippet: cleanSnippet(raw.snippet),
    date,
    unread: raw.unread,
  };
}

/**
 * Build the Jev `state` object for one email. Metadata only unless a body is
 * supplied by the opt-in deep pass. Email content is always passed as data.
 */
export function buildJevState(
  email: EmailMetadata,
  settings: Pick<Settings, 'privacyMode'>,
  body?: string,
): Record<string, unknown> {
  const emailState: Record<string, unknown> = {
    subject: email.subject,
    received: email.date,
  };

  if (settings.privacyMode) {
    emailState.sender = { address: redactEmailAddress(email.senderEmail) };
    emailState.snippet = truncate(email.snippet, 120);
  } else {
    emailState.sender = {
      name: email.senderName,
      address: email.senderEmail,
    };
    emailState.snippet = email.snippet;
  }

  const state: Record<string, unknown> = { email: emailState };
  if (body && body.trim().length > 0) {
    state.body = truncate(cleanSnippet(body), 4000);
  }
  return state;
}
