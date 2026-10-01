import { describe, it, expect } from 'vitest';
import {
  buildJevState,
  cleanSnippet,
  computeEmailHash,
  makeEmailMetadata,
} from '../src/shared/metadata.js';
import { parseRetryAfterMs } from '../src/shared/provider.js';
import { costFromResponse, estimateCostUsd } from '../src/shared/cost.js';
import type { EmailMetadata, JevResponse } from '../src/shared/types.js';

function email(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
  return {
    id: 'id-1',
    hash: 'hash-1',
    senderName: 'Ada Lovelace',
    senderEmail: 'ada@example.com',
    subject: 'Hello',
    snippet: 'short snippet',
    date: '9:41 AM',
    unread: true,
    ...overrides,
  };
}

describe('cleanSnippet', () => {
  it('strips quoted lines, the "On ... wrote:" line, a signature marker and an unsubscribe footer', () => {
    const input = [
      'Thanks for the update.',
      'On Mon, Sep 1, 2025 at 9:41 AM Ada <ada@example.com> wrote:',
      '> quoted reply',
      '--',
      'Ada',
      'Unsubscribe from these emails',
    ].join('\n');
    expect(cleanSnippet(input)).toBe('Thanks for the update.');
  });

  it('collapses whitespace', () => {
    expect(cleanSnippet('  hello    world  ')).toBe('hello world');
  });

  it('returns an empty string for empty input', () => {
    expect(cleanSnippet('')).toBe('');
  });
});

describe('computeEmailHash', () => {
  it('is stable for the same inputs', () => {
    expect(computeEmailHash('a@b.com', 'Subject', '9:41 AM')).toBe(
      computeEmailHash('a@b.com', 'Subject', '9:41 AM'),
    );
  });

  it('differs when the subject differs', () => {
    expect(computeEmailHash('a@b.com', 'Subject A', '9:41 AM')).not.toBe(
      computeEmailHash('a@b.com', 'Subject B', '9:41 AM'),
    );
  });
});

describe('makeEmailMetadata', () => {
  it('normalises whitespace and lowercases the sender email', () => {
    const meta = makeEmailMetadata({
      senderName: '  Ada   Lovelace ',
      senderEmail: '  ADA@Example.COM ',
      subject: '  Hello   there ',
      snippet: '  hi  ',
      date: ' 9:41   AM ',
      unread: false,
    });
    expect(meta.senderName).toBe('Ada Lovelace');
    expect(meta.senderEmail).toBe('ada@example.com');
    expect(meta.subject).toBe('Hello there');
    expect(meta.date).toBe('9:41 AM');
    expect(meta.unread).toBe(false);
  });

  it('sets id to the hash when no idHint is given', () => {
    const meta = makeEmailMetadata({
      senderName: 'Ada',
      senderEmail: 'ada@example.com',
      subject: 'Hello',
      snippet: 'hi',
      date: '9:41 AM',
      unread: true,
    });
    expect(meta.id).toBe(meta.hash);
  });

  it('uses the idHint when provided', () => {
    const meta = makeEmailMetadata(
      {
        senderName: 'Ada',
        senderEmail: 'ada@example.com',
        subject: 'Hello',
        snippet: 'hi',
        date: '9:41 AM',
        unread: true,
      },
      'thread-42',
    );
    expect(meta.id).toBe('thread-42');
  });
});

describe('buildJevState', () => {
  it('includes sender name/address and the snippet in non-privacy mode', () => {
    const state = buildJevState(email(), { privacyMode: false });
    const emailState = state.email as Record<string, unknown>;
    expect(emailState.sender).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' });
    expect(emailState.snippet).toBe('short snippet');
  });

  it('omits the name, redacts the address and truncates a long snippet in privacy mode', () => {
    const longSnippet = 'x'.repeat(300);
    const state = buildJevState(email({ snippet: longSnippet }), { privacyMode: true });
    const emailState = state.email as Record<string, unknown>;
    expect(emailState.sender).toEqual({ address: '***@example.com' });
    expect(emailState.snippet).toBe('x'.repeat(119) + '\u2026');
    expect((emailState.snippet as string).length).toBe(120);
  });

  it('adds a cleaned body field when a body is supplied', () => {
    const state = buildJevState(email(), { privacyMode: false }, 'Body line\n> quoted');
    expect(state.body).toBe('Body line');
  });

  it('omits the body field when the body is blank', () => {
    const state = buildJevState(email(), { privacyMode: false }, '   ');
    expect(state.body).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it('converts a seconds string to milliseconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('converts an HTTP date to a positive number of milliseconds', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfterMs(future);
    expect(result).toBeDefined();
    expect(result).toBeGreaterThan(0);
  });

  it('returns undefined for null', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('cost', () => {
  it('estimates $0.042 for one million input tokens', () => {
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.042, 10);
  });

  it('prefers provider_metadata.gateway.cost when present', () => {
    const response: JevResponse = {
      model: 'jev-latest',
      answers: {},
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      provider_metadata: { gateway: { cost: '0.007' } },
    };
    expect(costFromResponse(response)).toBeCloseTo(0.007, 10);
  });

  it('falls back to usage when the gateway cost is absent', () => {
    const response: JevResponse = {
      model: 'jev-latest',
      answers: {},
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    };
    expect(costFromResponse(response)).toBeCloseTo(0.042, 10);
  });

  it('returns undefined when there is neither gateway cost nor usage', () => {
    const response: JevResponse = { model: 'jev-latest', answers: {} };
    expect(costFromResponse(response)).toBeUndefined();
  });
});
