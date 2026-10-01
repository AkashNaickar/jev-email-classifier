import { JevError } from './errors.js';
import { QID, resolveCategoryChoice } from './questions.js';
import type {
  Answer,
  ChoiceAnswer,
  Classification,
  EmailMetadata,
  JevResponse,
  NoulAnswer,
  ProviderId,
  ScoreAnswer,
  Settings,
} from './types.js';
import { clamp } from './util.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseProbabilities(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const n = asNumber(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function parseAnswer(id: string, value: unknown): Answer {
  if (!isRecord(value)) throw new JevError('schema', `answers.${id} is not an object`);
  const type = value.type;
  if (type === 'noul') {
    const noul = asNumber(value.noul);
    if (noul === undefined) throw new JevError('schema', `answers.${id}.noul is missing`);
    return { type: 'noul', noul: clamp(noul, 0, 1) };
  }
  if (type === 'choice') {
    if (typeof value.choice !== 'string') throw new JevError('schema', `answers.${id}.choice is missing`);
    const probabilities = parseProbabilities(value.probabilities);
    const confidence = asNumber(value.confidence) ?? maxProbability(probabilities);
    return { type: 'choice', choice: value.choice, confidence, probabilities };
  }
  if (type === 'score') {
    const score = asNumber(value.score);
    if (score === undefined) throw new JevError('schema', `answers.${id}.score is missing`);
    const probabilities = parseProbabilities(value.probabilities);
    const confidence = asNumber(value.confidence) ?? 0;
    const legend: Record<string, string> = {};
    if (isRecord(value.legend)) {
      for (const [k, v] of Object.entries(value.legend)) legend[k] = String(v);
    }
    return { type: 'score', score, confidence, probabilities, legend };
  }
  throw new JevError('schema', `answers.${id}.type is not noul|choice|score`);
}

function maxProbability(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  return values.length > 0 ? Math.max(...values) : 0;
}

/** Validate the raw HTTP body and normalise it into a JevResponse. */
export function parseJevResponse(raw: unknown): JevResponse {
  if (!isRecord(raw)) throw new JevError('schema', 'response is not an object');
  if (!isRecord(raw.answers)) throw new JevError('schema', 'response.answers is missing');
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    answers[id] = parseAnswer(id, value);
  }
  const usage = isRecord(raw.usage)
    ? {
        input_tokens: asNumber(raw.usage.input_tokens) ?? 0,
        output_tokens: asNumber(raw.usage.output_tokens) ?? 0,
      }
    : undefined;
  return {
    model: typeof raw.model === 'string' ? raw.model : '',
    answers,
    ...(usage ? { usage } : {}),
    ...(isRecord(raw.provider_metadata)
      ? { provider_metadata: raw.provider_metadata as JevResponse['provider_metadata'] }
      : {}),
  };
}

export interface PriorityResult {
  priority: 'low' | 'medium' | 'high';
  normalized: number;
}

/** Normalise a Score (0..levelCount-1) to 0..1 and bucket it. */
export function priorityFromScore(
  score: number,
  levelCount: number,
  settings: Pick<Settings, 'priorityHighThreshold' | 'priorityLowThreshold'>,
): PriorityResult {
  const top = Math.max(1, levelCount - 1);
  const normalized = clamp(score / top, 0, 1);
  let priority: PriorityResult['priority'];
  if (normalized >= settings.priorityHighThreshold) priority = 'high';
  else if (normalized <= settings.priorityLowThreshold) priority = 'low';
  else priority = 'medium';
  return { priority, normalized };
}

export interface BuildClassificationOptions {
  provider: ProviderId;
  now?: number;
  levelCount?: number;
  deep?: boolean;
}

/**
 * Turn a validated Jev response into a Classification for one email. Throws
 * JevError('schema') when a required answer is missing so the row surfaces an
 * error instead of a forced guess.
 */
export function classificationFromResponse(
  email: EmailMetadata,
  response: JevResponse,
  settings: Settings,
  options: BuildClassificationOptions,
): Classification {
  const category = response.answers[QID.category];
  const priority = response.answers[QID.priority];
  const spam = response.answers[QID.spam];
  const needsReply = response.answers[QID.needsReply];

  if (!category || category.type !== 'choice') {
    throw new JevError('schema', 'missing choice answer "category"');
  }
  if (!priority || priority.type !== 'score') {
    throw new JevError('schema', 'missing score answer "priority"');
  }
  if (!spam || spam.type !== 'noul') {
    throw new JevError('schema', 'missing noul answer "spam"');
  }
  if (!needsReply || needsReply.type !== 'noul') {
    throw new JevError('schema', 'missing noul answer "needs_reply"');
  }

  const choiceAnswer = category as ChoiceAnswer;
  const scoreAnswer = priority as ScoreAnswer;
  const spamAnswer = spam as NoulAnswer;
  const replyAnswer = needsReply as NoulAnswer;

  const resolved = resolveCategoryChoice(settings, choiceAnswer.choice);
  const legendLevels = Object.keys(scoreAnswer.legend).length;
  const levelCount = options.levelCount ?? (legendLevels > 0 ? legendLevels : 3);
  const { priority: priorityBucket, normalized } = priorityFromScore(
    scoreAnswer.score,
    levelCount,
    settings,
  );

  const uncertain = !resolved.known || choiceAnswer.confidence < settings.confidenceThreshold;

  return {
    emailId: email.id,
    hash: email.hash,
    categoryId: resolved.id,
    categoryName: resolved.name,
    categoryConfidence: choiceAnswer.confidence,
    probabilities: choiceAnswer.probabilities,
    priority: priorityBucket,
    priorityScore: normalized,
    priorityConfidence: scoreAnswer.confidence,
    spamProbability: clamp(spamAnswer.noul, 0, 1),
    needsReplyProbability: clamp(replyAnswer.noul, 0, 1),
    uncertain,
    model: response.model,
    provider: options.provider,
    at: options.now ?? Date.now(),
    ...(options.deep ? { deep: true } : {}),
  };
}
