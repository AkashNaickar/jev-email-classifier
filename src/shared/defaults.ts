import type { Category, Settings } from './types.js';

/** Sentinels and storage keys. */
export const UNCERTAIN_ID = '__uncertain__';
export const UNCERTAIN_NAME = 'Uncertain';

export const STORAGE_KEYS = {
  settings: 'settings',
  cache: 'cache',
  cacheMeta: 'cacheMeta',
  stats: 'stats',
  key: (provider: string) => `key:${provider}`,
} as const;

/** Provider configuration. Endpoints/fields verified against official docs. */
export const PROVIDERS = {
  typesafe: {
    id: 'typesafe' as const,
    label: 'TypeSafe',
    /** POST target for the System One evaluation endpoint. */
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    modelsEndpoint: 'https://api.typesafe.ai/v1/models',
    defaultModel: 'jev-latest',
    models: ['jev-latest', 'jev-preview', 'jev-1.13.0'],
    keyUrl: 'https://console.typesafe.ai/keys',
  },
  'vercel-gateway': {
    id: 'vercel-gateway' as const,
    label: 'Vercel AI Gateway',
    /** TypeSafe-compatible API on AI Gateway (same request/response shape). */
    endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    modelsEndpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/models',
    defaultModel: 'typesafe-ai/jev',
    models: ['typesafe-ai/jev'],
    keyUrl: 'https://vercel.com/docs/ai-gateway',
  },
} as const;

/** USD per input token: $0.042 / 1M. Output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const CACHE_LIMIT = 5000;

/** Choice-confidence below this shows the neutral chip by default. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.45;

export const MAX_CATEGORIES = 15;

/** Three descriptive Score levels for priority (indices 0..2). */
export const PRIORITY_LEVELS: string[] = [
  'Low: informational, automated, or promotional; nothing is expected from the recipient soon.',
  'Medium: useful or mildly time-sensitive; a reply or action is expected eventually but it is not urgent.',
  'High: needs the recipient soon; a person is waiting on a reply, a deadline is near, money/security/account issues, or it is clearly important.',
];

export const CATEGORY_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
];

export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'needs-reply',
    name: 'Needs reply',
    description:
      'A real person is asking the recipient a question or expecting a response. Direct messages, questions, and threads awaiting a personal answer.',
  },
  {
    id: 'action-required',
    name: 'Action required',
    description:
      'The recipient must do something: confirm, sign, pay, approve, verify, complete a form, or meet a deadline. Not just information.',
  },
  {
    id: 'updates',
    name: 'Updates',
    description:
      'Notifications and status updates about accounts, services, orders, or systems the recipient already uses. No reply or action expected.',
  },
  {
    id: 'newsletters',
    name: 'Newsletters',
    description:
      'Recurring editorial or digest email from a publication, community, or company the recipient subscribed to.',
  },
  {
    id: 'promotions',
    name: 'Promotions',
    description:
      'Marketing, sales, discounts, deals, product announcements, or anything trying to sell something.',
  },
  {
    id: 'receipts-finance',
    name: 'Receipts/Finance',
    description:
      'Receipts, invoices, order confirmations, statements, bills, payment confirmations, tax or banking documents.',
  },
  {
    id: 'social',
    name: 'Social',
    description:
      'Updates from social networks, forums, or dating apps: follows, likes, comments, mentions, connection requests.',
  },
  {
    id: 'spam',
    name: 'Spam',
    description:
      'Unsolicited junk, scams, phishing, chain mail, or anything the recipient did not ask to receive.',
  },
];

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'typesafe',
  categories: DEFAULT_CATEGORIES,
  confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  priorityHighThreshold: 0.66,
  priorityLowThreshold: 0.34,
  privacyMode: false,
  deepMode: false,
  groupByPriority: false,
  classifyUnreadOnly: true,
  maxCategories: MAX_CATEGORIES,
};

/** A fresh copy (never hand out the shared object). */
export function freshDefaultSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  };
}
