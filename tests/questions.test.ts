import { describe, it, expect } from 'vitest';
import {
  QID,
  buildQuestions,
  resolveCategories,
  resolveCategoryChoice,
} from '../src/shared/questions.js';
import {
  DEFAULT_CATEGORIES,
  UNCERTAIN_ID,
  UNCERTAIN_NAME,
  freshDefaultSettings,
} from '../src/shared/defaults.js';
import type { Category, ChoiceQuestion, NoulQuestion, ScoreQuestion, Settings } from '../src/shared/types.js';

function settingsWith(categories: Category[], maxCategories = 15): Settings {
  return { ...freshDefaultSettings(), categories, maxCategories };
}

describe('buildQuestions', () => {
  it('returns exactly the four question ids with the expected types', () => {
    const questions = buildQuestions(freshDefaultSettings());
    expect(Object.keys(questions).sort()).toEqual(
      [QID.category, QID.priority, QID.spam, QID.needsReply].sort(),
    );
    expect(questions[QID.category].type).toBe('choice');
    expect(questions[QID.priority].type).toBe('score');
    expect(questions[QID.spam].type).toBe('noul');
    expect(questions[QID.needsReply].type).toBe('noul');
  });

  it('maps choice criteria keys to category ids and values to descriptions', () => {
    const categories: Category[] = [
      { id: 'a', name: 'A', description: 'desc-a' },
      { id: 'b', name: 'B', description: 'desc-b' },
    ];
    const questions = buildQuestions(settingsWith(categories));
    const choice = questions[QID.category] as ChoiceQuestion;
    expect(Object.keys(choice.criteria).sort()).toEqual(['a', 'b']);
    expect(choice.criteria.a).toBe('desc-a');
    expect(choice.criteria.b).toBe('desc-b');
  });

  it('maps a category with an empty description to null', () => {
    const categories: Category[] = [{ id: 'empty', name: 'Empty', description: '' }];
    const questions = buildQuestions(settingsWith(categories));
    const choice = questions[QID.category] as ChoiceQuestion;
    expect(choice.criteria.empty).toBeNull();
  });

  it('builds the priority score from the three priority levels', () => {
    const questions = buildQuestions(freshDefaultSettings());
    const score = questions[QID.priority] as ScoreQuestion;
    expect(score.criteria).toHaveLength(3);
  });

  it('builds noul criteria with true/false instructions', () => {
    const questions = buildQuestions(freshDefaultSettings());
    const spam = questions[QID.spam] as NoulQuestion;
    const reply = questions[QID.needsReply] as NoulQuestion;
    expect(spam.criteria?.true).toBeTruthy();
    expect(spam.criteria?.false).toBeTruthy();
    expect(reply.criteria?.true).toBeTruthy();
    expect(reply.criteria?.false).toBeTruthy();
  });
});

describe('resolveCategories', () => {
  it('falls back to DEFAULT_CATEGORIES when given an empty list', () => {
    const resolved = resolveCategories({ categories: [], maxCategories: 15 });
    expect(resolved).toEqual(DEFAULT_CATEGORIES);
  });

  it('filters entries missing an id or a name', () => {
    const categories = [
      { id: 'ok', name: 'Ok', description: 'd' },
      { id: '', name: 'No id', description: 'd' },
      { id: 'no-name', name: '', description: 'd' },
    ] as Category[];
    const resolved = resolveCategories({ categories, maxCategories: 15 });
    expect(resolved.map((c) => c.id)).toEqual(['ok']);
  });

  it('respects maxCategories slicing', () => {
    const categories: Category[] = [
      { id: 'a', name: 'A', description: 'a' },
      { id: 'b', name: 'B', description: 'b' },
      { id: 'c', name: 'C', description: 'c' },
    ];
    const resolved = resolveCategories({ categories, maxCategories: 2 });
    expect(resolved.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('treats a non-positive maxCategories as no cap', () => {
    const categories: Category[] = [
      { id: 'a', name: 'A', description: 'a' },
      { id: 'b', name: 'B', description: 'b' },
    ];
    const resolved = resolveCategories({ categories, maxCategories: 0 });
    expect(resolved).toHaveLength(2);
  });
});

describe('resolveCategoryChoice', () => {
  it('resolves a known id to known:true with its name', () => {
    const settings = settingsWith([{ id: 'known', name: 'Known', description: 'd' }]);
    const resolved = resolveCategoryChoice(settings, 'known');
    expect(resolved).toEqual({ id: 'known', name: 'Known', known: true });
  });

  it('maps an unknown id to the uncertain sentinel with known:false', () => {
    const settings = settingsWith([{ id: 'known', name: 'Known', description: 'd' }]);
    const resolved = resolveCategoryChoice(settings, 'mystery');
    expect(resolved).toEqual({ id: UNCERTAIN_ID, name: UNCERTAIN_NAME, known: false });
  });

  it('passes the uncertain sentinel through as known:true', () => {
    const settings = settingsWith([{ id: 'known', name: 'Known', description: 'd' }]);
    const resolved = resolveCategoryChoice(settings, UNCERTAIN_ID);
    expect(resolved).toEqual({ id: UNCERTAIN_ID, name: UNCERTAIN_NAME, known: true });
  });
});
