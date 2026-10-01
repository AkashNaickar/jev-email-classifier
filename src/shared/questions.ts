import { DEFAULT_CATEGORIES, PRIORITY_LEVELS, UNCERTAIN_ID, UNCERTAIN_NAME } from './defaults.js';
import type { Category, Questions, Settings } from './types.js';

/** Question ids. These are local keys and are never sent to the model. */
export const QID = {
  category: 'category',
  priority: 'priority',
  spam: 'spam',
  needsReply: 'needs_reply',
} as const;

/** Categories with at least an id and name, falling back to defaults. */
export function resolveCategories(settings: Pick<Settings, 'categories' | 'maxCategories'>): Category[] {
  const cleaned = (settings.categories ?? []).filter((c) => c && c.id && c.name);
  const list = cleaned.length > 0 ? cleaned : DEFAULT_CATEGORIES;
  const cap = settings.maxCategories > 0 ? settings.maxCategories : list.length;
  return list.slice(0, cap);
}

/**
 * Build the Jev question set for one email: a Choice for the category, a Score
 * for priority, and two Nouls (spam, needs-reply). See PLAN.md §5.
 */
export function buildQuestions(settings: Settings): Questions {
  const categories = resolveCategories(settings);
  const criteria: Record<string, string | null> = {};
  for (const c of categories) criteria[c.id] = c.description ? c.description : null;

  return {
    [QID.category]: {
      type: 'choice',
      instructions:
        'Classify this email into exactly one category. Pick the single best fit, using the option descriptions.',
      criteria,
    },
    [QID.priority]: {
      type: 'score',
      instructions: "How much does this email need the recipient's attention soon?",
      criteria: [...PRIORITY_LEVELS],
    },
    [QID.spam]: {
      type: 'noul',
      instructions: 'Is this email unsolicited junk, a scam, phishing, or spam?',
      criteria: {
        true: 'Unsolicited, deceptive, scam, phishing, or bulk junk the recipient did not ask to receive',
        false: 'Legitimate mail the recipient would expect, even if promotional or automated',
      },
    },
    [QID.needsReply]: {
      type: 'noul',
      instructions: 'Does this email expect a reply from the recipient (a person is waiting on an answer)?',
      criteria: {
        true: 'A person asks a question or clearly expects a personal response',
        false: 'Automated, informational, promotional, or otherwise no reply expected',
      },
    },
  };
}

export function categoryNameFor(settings: Settings, id: string): string {
  if (id === UNCERTAIN_ID) return UNCERTAIN_NAME;
  const found = resolveCategories(settings).find((c) => c.id === id);
  return found ? found.name : id;
}

export interface ResolvedCategory {
  id: string;
  name: string;
  known: boolean;
}

/**
 * Map a raw Choice answer back to a configured category. An unknown option is
 * treated as uncertain rather than trusted blindly.
 */
export function resolveCategoryChoice(settings: Settings, raw: string): ResolvedCategory {
  const known = resolveCategories(settings).some((c) => c.id === raw);
  if (known) return { id: raw, name: categoryNameFor(settings, raw), known: true };
  if (raw === UNCERTAIN_ID) return { id: UNCERTAIN_ID, name: UNCERTAIN_NAME, known: true };
  return { id: UNCERTAIN_ID, name: UNCERTAIN_NAME, known: false };
}
