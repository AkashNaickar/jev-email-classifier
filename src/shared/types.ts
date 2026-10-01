/**
 * Frozen shared contract for the Jev Gmail Classifier.
 *
 * Both the content script and the service worker import from this file, so the
 * message protocol and the Jev request/response shapes live in exactly one
 * place. Do not duplicate these types elsewhere.
 */

export type ProviderId = 'typesafe' | 'vercel-gateway';

export interface Category {
  /** Stable id; used as the Jev Choice option key. */
  id: string;
  /** Chip label shown to the user. */
  name: string;
  /** Natural-language criteria sent to Jev for this option. */
  description: string;
  /** Optional explicit chip colour; otherwise derived from list position. */
  color?: string;
}

export type Priority = 'low' | 'medium' | 'high';

/** Everything the content script extracts from a single Gmail list row. */
export interface EmailMetadata {
  /** Gmail's thread/row id when available, else the metadata hash. */
  id: string;
  /** Stable hash of sender + subject + date; the cache key. */
  hash: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  /** Raw date text as Gmail renders it (e.g. "9:41 AM" or "Sep 3"). */
  date: string;
  unread: boolean;
}

/**
 * Jev question/answer shapes, exactly as documented at docs.typesafe.ai.
 * `instructions` and each criteria entry may be a string, object, or array.
 */
export type InstructionValue = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: InstructionValue;
  criteria?: { true?: InstructionValue; false?: InstructionValue };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: InstructionValue;
  criteria: Record<string, string | Record<string, unknown> | unknown[] | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: InstructionValue;
  criteria: InstructionValue[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: JevUsage;
  provider_metadata?: {
    gateway?: {
      cost?: string;
      routing?: Record<string, unknown>;
    };
  };
}

/** Final per-email result rendered by the content script. */
export interface Classification {
  emailId: string;
  hash: string;
  categoryId: string;
  categoryName: string;
  categoryConfidence: number;
  probabilities: Record<string, number>;
  priority: Priority;
  /** Priority score normalised to 0..1 across the Score levels. */
  priorityScore: number;
  priorityConfidence: number;
  spamProbability: number;
  needsReplyProbability: number;
  /** True when category confidence fell below the user threshold. */
  uncertain: boolean;
  model: string;
  provider: ProviderId;
  /** Epoch ms. */
  at: number;
  /** True when this came from the deep (body) pass. */
  deep?: boolean;
}

export interface Settings {
  enabled: boolean;
  provider: ProviderId;
  categories: Category[];
  /** Below this Choice confidence, show the neutral "Uncertain" chip. */
  confidenceThreshold: number;
  /** Normalised priority score >= this => high. */
  priorityHighThreshold: number;
  /** Normalised priority score <= this => low. */
  priorityLowThreshold: number;
  /** When true, sender name/address are omitted from the state sent to Jev. */
  privacyMode: boolean;
  /** Opt-in: after opening an ambiguous email, re-classify using its body. */
  deepMode: boolean;
  /** On-screen-only grouping of rows by priority (CSS transform, never DOM order). */
  groupByPriority: boolean;
  classifyUnreadOnly: boolean;
  maxCategories: number;
}

export interface StatusStats {
  classified: number;
  inFlight: number;
  errors: number;
  estimatedCostUsd: number;
  cached: number;
}

export interface ErrorInfo {
  emailId: string;
  /** Cache key of the failing email, so the content script can map it back. */
  hash: string;
  code: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Message protocol                                                    */
/* ------------------------------------------------------------------ */

export interface ClassifyMessage {
  type: 'CLASSIFY';
  requestId: string;
  emails: EmailMetadata[];
}
export interface DeepClassifyMessage {
  type: 'DEEP_CLASSIFY';
  requestId: string;
  email: EmailMetadata;
  body: string;
}
export interface GetStatusMessage {
  type: 'GET_STATUS';
}
export interface ContentReadyMessage {
  type: 'CONTENT_READY';
}

export type ContentToBackground =
  | ClassifyMessage
  | DeepClassifyMessage
  | GetStatusMessage
  | ContentReadyMessage;

export type UiToBackground =
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'SET_KEY'; provider: ProviderId; apiKey: string }
  | { type: 'CLEAR_KEY'; provider: ProviderId }
  | { type: 'KEY_STATUS' }
  | { type: 'TEST_CONNECTION'; provider: ProviderId; apiKey?: string }
  | { type: 'CLEAR_CACHE' }
  | { type: 'CACHE_STATS' };

export type BackgroundToContent =
  | {
      type: 'CLASSIFY_RESULT';
      requestId: string;
      results: Classification[];
      errors: ErrorInfo[];
    }
  | { type: 'STATUS'; stats: StatusStats }
  | { type: 'WARNING'; message: string };

export type BackgroundToUi =
  | { type: 'SETTINGS'; settings: Settings }
  | { type: 'KEY_STATUS'; keys: Partial<Record<ProviderId, string>> }
  | {
      type: 'TEST_RESULT';
      ok: boolean;
      message: string;
      model?: string;
      latencyMs?: number;
      costUsd?: number;
    }
  | { type: 'CACHE_STATS'; count: number; bytes: number }
  | { type: 'ERROR'; message: string };

export type ExtensionMessage =
  | ContentToBackground
  | UiToBackground
  | BackgroundToContent
  | BackgroundToUi;
