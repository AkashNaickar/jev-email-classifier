/**
 * Evaluation harness for the Jev Gmail Classifier.
 *
 * Two modes:
 *  - LIVE: TYPESAFE_API_KEY or AI_GATEWAY_API_KEY is set. Calls Jev for every
 *    fixture and reports real accuracy.
 *  - STUB: no key. Uses a deterministic keyword heuristic as a placeholder so
 *    the harness still runs offline. STUB numbers are NOT Jev accuracy.
 *
 * Run with: npm run eval
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { costFromResponse, formatUsd } from '../src/shared/cost.js';
import { DEFAULT_CATEGORIES, freshDefaultSettings } from '../src/shared/defaults.js';
import { JevError } from '../src/shared/errors.js';
import { buildJevState, makeEmailMetadata } from '../src/shared/metadata.js';
import type { RawRowFields } from '../src/shared/metadata.js';
import { classificationFromResponse, isRecord } from '../src/shared/parse.js';
import { createProvider } from '../src/shared/provider.js';
import type { JevProvider } from '../src/shared/provider.js';
import { buildQuestions } from '../src/shared/questions.js';
import { runWithConcurrency, withRetry } from '../src/shared/queue.js';
import type {
  Classification,
  EmailMetadata,
  Priority,
  ProviderId,
  Questions,
  Settings,
} from '../src/shared/types.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface Fixture extends RawRowFields {
  expectedCategory: string;
  note: string;
}

const CATEGORY_IDS: readonly string[] = DEFAULT_CATEGORIES.map((c) => c.id);
const CATEGORY_ID_SET = new Set(CATEGORY_IDS);

function requireString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`fixture[${index}].${key} must be a string`);
  return value;
}

function parseFixtures(text: string): Fixture[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('fixtures/emails.json must be a JSON array');
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error(`fixture[${index}] must be an object`);
    const unread = item.unread;
    if (typeof unread !== 'boolean') throw new Error(`fixture[${index}].unread must be a boolean`);
    const expectedCategory = requireString(item, 'expectedCategory', index);
    if (!CATEGORY_ID_SET.has(expectedCategory)) {
      throw new Error(`fixture[${index}].expectedCategory "${expectedCategory}" is not a known category id`);
    }
    return {
      senderName: requireString(item, 'senderName', index),
      senderEmail: requireString(item, 'senderEmail', index),
      subject: requireString(item, 'subject', index),
      snippet: requireString(item, 'snippet', index),
      date: requireString(item, 'date', index),
      unread,
      expectedCategory,
      note: requireString(item, 'note', index),
    };
  });
}

/* ------------------------------------------------------------------ */
/* STUB heuristic (deterministic placeholder, not Jev)                 */
/* ------------------------------------------------------------------ */

interface CategoryRule {
  id: string;
  keywords: readonly string[];
}

/** Order also acts as the tie-break when two categories score equally. */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    id: 'spam',
    keywords: [
      'verify your account',
      'unusual sign-in',
      'click here',
      'you have won',
      'claim now',
      'gift card',
      'bitcoin',
      'guaranteed returns',
      'act now',
      'password expires',
      'wire transfer',
      'account locked',
      'confirm your identity',
      'suspended',
    ],
  },
  {
    id: 'action-required',
    keywords: [
      'action required',
      'please confirm',
      'confirm your',
      'verify your',
      'please verify',
      'sign the',
      'complete your',
      'deadline',
      'expires',
      'expiring',
      'renew now',
      'update your payment',
      'security alert',
      'reset your password',
      "if this wasn't you",
      'immediately',
      'final notice',
      'reactivate',
    ],
  },
  {
    id: 'receipts-finance',
    keywords: [
      'invoice',
      'receipt',
      'order confirmation',
      'payment received',
      'payment confirmation',
      'statement',
      'billing',
      'tax',
      'transaction',
      'your order',
      'has shipped',
      'out for delivery',
      'subscription renewed',
      'refund',
      'amount due',
      'balance due',
      'payable by',
      'total:',
    ],
  },
  {
    id: 'promotions',
    keywords: [
      'sale',
      '% off',
      'discount',
      'deal',
      'coupon',
      'promo',
      'last chance',
      'exclusive offer',
      'free shipping',
      'buy now',
      'save up to',
      'limited time',
      'new arrivals',
      'flash sale',
      'offer',
      'bogo',
    ],
  },
  {
    id: 'social',
    keywords: [
      'started following',
      'followed you',
      'liked your',
      'commented on',
      'mentioned you',
      'connection request',
      'new follower',
      'tagged you',
      'friend request',
      'new comments',
      'replying to your',
      'reacted to',
    ],
  },
  {
    id: 'needs-reply',
    keywords: [
      'could you',
      'can you',
      'would you',
      'are you available',
      'quick question',
      'your thoughts',
      'let me know',
      'following up',
      'please reply',
      'do you have time',
      'can we',
      'any chance',
    ],
  },
  {
    id: 'newsletters',
    keywords: [
      'newsletter',
      'digest',
      'weekly',
      'monthly roundup',
      'issue #',
      'this week',
      'read more',
      'top stories',
      'monthly recap',
      'bulletin',
      'community update',
    ],
  },
  {
    id: 'updates',
    keywords: [
      'fyi',
      'status update',
      'now available',
      'maintenance',
      'has been updated',
      'changelog',
      'release notes',
      'notification',
      'scheduled',
      'your package',
      'on the way',
      'delivery update',
    ],
  },
];

const HIGH_PRIORITY_KEYWORDS: readonly string[] = [
  'urgent',
  'immediately',
  'asap',
  'deadline',
  'expires',
  'expiring',
  'within 24 hours',
  'security alert',
  'final notice',
  'overdue',
  'tonight',
  'action required',
  'before the end',
];

const LOW_PRIORITY_CATEGORIES = new Set(['promotions', 'newsletters', 'updates', 'social']);

function countMatches(haystack: string, keywords: readonly string[]): number {
  let n = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) n++;
  }
  return n;
}

function keywordsFor(id: string): readonly string[] {
  const rule = CATEGORY_RULES.find((r) => r.id === id);
  return rule ? rule.keywords : [];
}

/** Deterministic keyword placeholder used only when no API key is present. */
function heuristicClassify(email: EmailMetadata, providerId: ProviderId): Classification {
  const haystack = `${email.subject} ${email.snippet}`.toLowerCase();

  let bestId = 'updates';
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const score = countMatches(haystack, rule.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestId = rule.id;
    }
  }

  const category = DEFAULT_CATEGORIES.find((c) => c.id === bestId) ?? DEFAULT_CATEGORIES[0];
  const isHigh = HIGH_PRIORITY_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const priority: Priority = isHigh ? 'high' : LOW_PRIORITY_CATEGORIES.has(bestId) ? 'low' : 'medium';
  const priorityScore = priority === 'high' ? 0.9 : priority === 'low' ? 0.1 : 0.5;
  const spamProbability = bestId === 'spam' ? 0.9 : countMatches(haystack, keywordsFor('spam')) > 0 ? 0.5 : 0.05;
  const needsReplyProbability =
    bestId === 'needs-reply' ? 0.9 : countMatches(haystack, keywordsFor('needs-reply')) > 0 ? 0.5 : 0.05;

  return {
    emailId: email.id,
    hash: email.hash,
    categoryId: category.id,
    categoryName: category.name,
    categoryConfidence: 0.7,
    probabilities: { [category.id]: 0.7 },
    priority,
    priorityScore,
    priorityConfidence: 0.7,
    spamProbability,
    needsReplyProbability,
    uncertain: false,
    model: 'stub-heuristic',
    provider: providerId,
    at: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* LIVE evaluation                                                     */
/* ------------------------------------------------------------------ */

interface EvalRow {
  fixture: Fixture;
  email: EmailMetadata;
  classification?: Classification;
  error?: string;
  inputTokens: number;
  costUsd: number;
}

function resolveProviderId(raw: string | undefined, hasTypesafe: boolean, hasGateway: boolean): ProviderId {
  if (raw === 'typesafe' || raw === 'vercel-gateway') return raw;
  if (hasTypesafe) return 'typesafe';
  if (hasGateway) return 'vercel-gateway';
  return 'typesafe';
}

async function evaluateLive(
  rows: EvalRow[],
  provider: JevProvider,
  apiKey: string,
  settings: Settings,
  questions: Questions,
  providerId: ProviderId,
): Promise<EvalRow[]> {
  return runWithConcurrency(rows, 3, async (row) => {
    if (!apiKey) return { ...row, error: 'no_key' };
    try {
      const result = await withRetry(
        () => provider.callJev(buildJevState(row.email, settings), questions, { apiKey }),
        {
          retries: 2,
          baseDelayMs: 500,
          maxDelayMs: 4000,
          isRetryable: (error) => error instanceof JevError && error.retryable,
          onRetry: ({ attempt, delayMs, error }) => {
            const code = error instanceof JevError ? error.code : 'unknown';
            console.log(`  retry ${attempt} for "${row.fixture.subject}" after ${delayMs}ms (${code})`);
          },
        },
      );
      const classification = classificationFromResponse(row.email, result.response, settings, {
        provider: providerId,
      });
      const costUsd = costFromResponse(result.response) ?? result.costUsd ?? 0;
      return {
        ...row,
        classification,
        inputTokens: result.response.usage?.input_tokens ?? 0,
        costUsd,
      };
    } catch (error) {
      const code = error instanceof JevError ? error.code : 'unknown';
      console.log(`  error for "${row.fixture.subject}": ${code}`);
      return { ...row, error: code };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function report(rows: EvalRow[], live: boolean): number {
  const columns: string[] = [...CATEGORY_IDS];
  for (const row of rows) {
    const predicted = row.classification?.categoryId;
    if (predicted && !columns.includes(predicted)) columns.push(predicted);
  }

  const counts = new Map<string, number>();
  const bump = (expected: string, predicted: string): void => {
    const key = `${expected}\u0000${predicted}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const get = (expected: string, predicted: string): number =>
    counts.get(`${expected}\u0000${predicted}`) ?? 0;

  let correct = 0;
  let total = 0;
  const misclassified: { subject: string; expected: string; predicted: string }[] = [];

  for (const row of rows) {
    const classification = row.classification;
    if (!classification) continue;
    total++;
    const expected = row.fixture.expectedCategory;
    const predicted = classification.categoryId;
    bump(expected, predicted);
    if (expected === predicted) correct++;
    else misclassified.push({ subject: row.fixture.subject, expected, predicted });
  }

  console.log('');
  console.log(
    live
      ? 'Results (LIVE — real Jev calls)'
      : 'Results (STUB — keyword heuristic placeholder, NOT Jev accuracy)',
  );
  const accuracy = ratio(correct, total);
  console.log(`accuracy: ${correct}/${total} (${(accuracy * 100).toFixed(1)}%)`);
  const errored = rows.filter((row) => row.classification === undefined);
  if (errored.length > 0) {
    console.log(`excluded rows (errors): ${errored.length}`);
    for (const row of errored) console.log(`  - "${row.fixture.subject}": ${row.error ?? 'unknown'}`);
  }

  console.log('');
  console.log('Per-category metrics (precision / recall / F1 / support)');
  const metricWidth = Math.max(16, ...CATEGORY_IDS.map((id) => id.length + 1));
  console.log(
    `${padEnd('category', metricWidth)}${padStart('precision', 11)}${padStart('recall', 9)}${padStart('F1', 9)}${padStart('support', 9)}`,
  );
  for (const id of CATEGORY_IDS) {
    const truePositives = get(id, id);
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const other of columns) {
      if (other !== id) {
        falsePositives += get(other, id);
        falseNegatives += get(id, other);
      }
    }
    const precision = ratio(truePositives, truePositives + falsePositives);
    const recall = ratio(truePositives, truePositives + falseNegatives);
    const f1 = ratio(2 * precision * recall, precision + recall);
    console.log(
      `${padEnd(id, metricWidth)}${padStart(precision.toFixed(2), 11)}${padStart(recall.toFixed(2), 9)}${padStart(f1.toFixed(2), 9)}${padStart(String(truePositives + falseNegatives), 9)}`,
    );
  }

  console.log('');
  console.log('Confusion matrix (rows = expected, columns = predicted)');
  const colWidth = Math.max(9, ...columns.map((id) => id.length + 1));
  const rowWidth = Math.max('expected \\ predicted'.length, ...CATEGORY_IDS.map((id) => id.length + 1));
  console.log(`${padEnd('expected \\ predicted', rowWidth)}${columns.map((id) => padStart(id, colWidth)).join('')}`);
  for (const expected of CATEGORY_IDS) {
    const cells = columns.map((predicted) => padStart(String(get(expected, predicted)), colWidth)).join('');
    console.log(`${padEnd(expected, rowWidth)}${cells}`);
  }

  console.log('');
  console.log(`Misclassified: ${misclassified.length}`);
  for (const item of misclassified) {
    console.log(`  - "${item.subject}" expected=${item.expected} predicted=${item.predicted}`);
  }

  if (live) {
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const costUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
    console.log('');
    console.log(`usage: ${inputTokens} input tokens | est. cost ${formatUsd(costUsd)}`);
  }

  return accuracy;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturesPath = path.resolve(here, '../fixtures/emails.json');
  const fixtures = parseFixtures(readFileSync(fixturesPath, 'utf8'));

  const settings = freshDefaultSettings();
  const questions = buildQuestions(settings);

  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  const hasTypesafe = Boolean(typesafeKey);
  const hasGateway = Boolean(gatewayKey);
  const live = hasTypesafe || hasGateway;
  const providerId = resolveProviderId(process.env.PROVIDER, hasTypesafe, hasGateway);

  const cases: EvalRow[] = fixtures.map((fixture) => ({
    fixture,
    email: makeEmailMetadata(fixture),
    inputTokens: 0,
    costUsd: 0,
  }));

  console.log('Jev classifier evaluation');
  console.log(`fixtures: ${fixtures.length}`);
  console.log(`mode: ${live ? 'LIVE' : 'STUB'} | provider: ${providerId}`);
  if (!live) {
    console.log('No TYPESAFE_API_KEY / AI_GATEWAY_API_KEY found: running offline with the stub heuristic.');
  }

  let rows: EvalRow[];
  if (live) {
    const apiKey = providerId === 'typesafe' ? typesafeKey ?? gatewayKey ?? '' : gatewayKey ?? typesafeKey ?? '';
    const provider = createProvider(providerId);
    rows = await evaluateLive(cases, provider, apiKey, settings, questions, providerId);
  } else {
    rows = cases.map((row) => ({ ...row, classification: heuristicClassify(row.email, providerId) }));
  }

  const accuracy = report(rows, live);
  process.exitCode = live && accuracy < 0.5 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('eval failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
