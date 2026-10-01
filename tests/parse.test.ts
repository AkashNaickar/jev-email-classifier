import { describe, it, expect } from 'vitest';
import {
  classificationFromResponse,
  parseJevResponse,
  priorityFromScore,
} from '../src/shared/parse.js';
import { JevError } from '../src/shared/errors.js';
import { QID } from '../src/shared/questions.js';
import { freshDefaultSettings } from '../src/shared/defaults.js';
import type {
  ChoiceAnswer,
  EmailMetadata,
  JevResponse,
  NoulAnswer,
  ScoreAnswer,
  Settings,
} from '../src/shared/types.js';

function email(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
  return {
    id: 'id-1',
    hash: 'hash-1',
    senderName: 'Ada',
    senderEmail: 'ada@example.com',
    subject: 'Hello',
    snippet: 'hi',
    date: '9:41 AM',
    unread: true,
    ...overrides,
  };
}

function validRaw(): Record<string, unknown> {
  return {
    model: 'jev-latest',
    answers: {
      [QID.category]: {
        type: 'choice',
        choice: 'needs-reply',
        confidence: 0.9,
        probabilities: { 'needs-reply': 0.9, updates: 0.1 },
      },
      [QID.priority]: {
        type: 'score',
        score: 2,
        confidence: 0.8,
        legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
        probabilities: { '2': 0.8 },
      },
      [QID.spam]: { type: 'noul', noul: 0.1 },
      [QID.needsReply]: { type: 'noul', noul: 0.95 },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function validResponse(): JevResponse {
  return parseJevResponse(validRaw());
}

function expectSchemaError(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a JevError to be thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).code).toBe('schema');
  }
}

describe('parseJevResponse', () => {
  it('accepts a well-formed response and returns typed answers plus usage', () => {
    const response = parseJevResponse(validRaw());
    expect(response.model).toBe('jev-latest');
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 20 });

    const category = response.answers[QID.category] as ChoiceAnswer;
    expect(category.type).toBe('choice');
    expect(category.choice).toBe('needs-reply');
    expect(category.confidence).toBe(0.9);
    expect(category.probabilities).toEqual({ 'needs-reply': 0.9, updates: 0.1 });

    const priority = response.answers[QID.priority] as ScoreAnswer;
    expect(priority.type).toBe('score');
    expect(priority.score).toBe(2);
    expect(priority.legend).toEqual({ '0': 'Low', '1': 'Medium', '2': 'High' });

    const spam = response.answers[QID.spam] as NoulAnswer;
    expect(spam).toEqual({ type: 'noul', noul: 0.1 });
  });

  it('defaults choice confidence from the max probability when missing', () => {
    const raw = validRaw();
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    delete answers[QID.category].confidence;
    const response = parseJevResponse(raw);
    const category = response.answers[QID.category] as ChoiceAnswer;
    expect(category.confidence).toBe(0.9);
  });

  it('defaults score confidence to 0 when missing', () => {
    const raw = validRaw();
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    delete answers[QID.priority].confidence;
    const response = parseJevResponse(raw);
    const priority = response.answers[QID.priority] as ScoreAnswer;
    expect(priority.confidence).toBe(0);
  });

  it('throws schema for a non-object response', () => {
    expectSchemaError(() => parseJevResponse('nope'));
  });

  it('throws schema when answers is missing', () => {
    expectSchemaError(() => parseJevResponse({ model: 'x' }));
  });

  it('throws schema for an answer with an unknown type', () => {
    expectSchemaError(() =>
      parseJevResponse({ answers: { [QID.spam]: { type: 'weird' } } }),
    );
  });

  it('throws schema for a choice missing choice', () => {
    expectSchemaError(() =>
      parseJevResponse({ answers: { [QID.category]: { type: 'choice' } } }),
    );
  });

  it('throws schema for a score missing score', () => {
    expectSchemaError(() =>
      parseJevResponse({ answers: { [QID.priority]: { type: 'score' } } }),
    );
  });

  it('throws schema for a noul missing noul', () => {
    expectSchemaError(() =>
      parseJevResponse({ answers: { [QID.spam]: { type: 'noul' } } }),
    );
  });
});

describe('priorityFromScore', () => {
  const settings = { priorityHighThreshold: 0.66, priorityLowThreshold: 0.34 };

  it('buckets at/above the high threshold as high', () => {
    expect(priorityFromScore(2, 3, settings).priority).toBe('high');
  });

  it('buckets at/below the low threshold as low', () => {
    expect(priorityFromScore(0, 3, settings).priority).toBe('low');
  });

  it('buckets between the thresholds as medium', () => {
    expect(priorityFromScore(1, 3, settings).priority).toBe('medium');
  });

  it('normalises score / (levels - 1) and clamps to 0..1', () => {
    expect(priorityFromScore(1, 3, settings).normalized).toBeCloseTo(0.5);
    expect(priorityFromScore(5, 3, settings).normalized).toBe(1);
    expect(priorityFromScore(-1, 3, settings).normalized).toBe(0);
  });
});

describe('classificationFromResponse', () => {
  const settings: Settings = freshDefaultSettings();

  it('maps a valid response into a full Classification', () => {
    const result = classificationFromResponse(email(), validResponse(), settings, {
      provider: 'typesafe',
      now: 1234,
    });
    expect(result.emailId).toBe('id-1');
    expect(result.hash).toBe('hash-1');
    expect(result.categoryId).toBe('needs-reply');
    expect(result.categoryName).toBe('Needs reply');
    expect(result.categoryConfidence).toBe(0.9);
    expect(result.priority).toBe('high');
    expect(result.priorityScore).toBe(1);
    expect(result.priorityConfidence).toBe(0.8);
    expect(result.spamProbability).toBe(0.1);
    expect(result.needsReplyProbability).toBe(0.95);
    expect(result.uncertain).toBe(false);
    expect(result.model).toBe('jev-latest');
    expect(result.provider).toBe('typesafe');
    expect(result.at).toBe(1234);
    expect(result.deep).toBeUndefined();
  });

  it('marks uncertain true when confidence is below the threshold', () => {
    const raw = validRaw();
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    answers[QID.category].confidence = 0.2;
    const result = classificationFromResponse(email(), parseJevResponse(raw), settings, {
      provider: 'typesafe',
    });
    expect(result.uncertain).toBe(true);
  });

  it('marks uncertain false when confidence is above the threshold', () => {
    const raw = validRaw();
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    answers[QID.category].confidence = 0.99;
    const result = classificationFromResponse(email(), parseJevResponse(raw), settings, {
      provider: 'typesafe',
    });
    expect(result.uncertain).toBe(false);
  });

  it('clamps spam and needs_reply to 0..1', () => {
    const raw = validRaw();
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    answers[QID.spam] = { type: 'noul', noul: 5 };
    answers[QID.needsReply] = { type: 'noul', noul: -3 };
    const result = classificationFromResponse(email(), parseJevResponse(raw), settings, {
      provider: 'typesafe',
    });
    expect(result.spamProbability).toBe(1);
    expect(result.needsReplyProbability).toBe(0);
  });

  it('sets deep:true only when options.deep is set', () => {
    const shallow = classificationFromResponse(email(), validResponse(), settings, {
      provider: 'typesafe',
    });
    const deep = classificationFromResponse(email(), validResponse(), settings, {
      provider: 'typesafe',
      deep: true,
    });
    expect(shallow.deep).toBeUndefined();
    expect(deep.deep).toBe(true);
  });

  it('throws schema when the category answer is missing', () => {
    const response = validResponse();
    delete response.answers[QID.category];
    expectSchemaError(() =>
      classificationFromResponse(email(), response, settings, { provider: 'typesafe' }),
    );
  });

  it('throws schema when the priority answer is missing', () => {
    const response = validResponse();
    delete response.answers[QID.priority];
    expectSchemaError(() =>
      classificationFromResponse(email(), response, settings, { provider: 'typesafe' }),
    );
  });

  it('throws schema when the spam answer is missing', () => {
    const response = validResponse();
    delete response.answers[QID.spam];
    expectSchemaError(() =>
      classificationFromResponse(email(), response, settings, { provider: 'typesafe' }),
    );
  });

  it('throws schema when the needs_reply answer is missing', () => {
    const response = validResponse();
    delete response.answers[QID.needsReply];
    expectSchemaError(() =>
      classificationFromResponse(email(), response, settings, { provider: 'typesafe' }),
    );
  });
});
