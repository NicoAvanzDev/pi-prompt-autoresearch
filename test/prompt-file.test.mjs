import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPromptFile } from '../prompt-file.ts';
import { createInitialJobSnapshot } from '../job-state.ts';

test('renderPromptFile writes the current best prompt with metadata', () => {
  const snapshot = createInitialJobSnapshot({
    goal: 'Write a strong card valuation prompt',
    goalSummary: 'Write a strong card valuation prompt',
    bestPrompt: 'You are an expert card grader.',
    iterations: 10,
    evalCaseCount: 5,
    now: Date.UTC(2026, 0, 1),
  });

  const content = renderPromptFile({
    ...snapshot,
    status: 'running',
    phase: 'kept-candidate',
    currentIteration: 4,
    updatedAt: Date.UTC(2026, 0, 1, 0, 5, 0),
    bestPrompt: 'You are an expert card grader. Inspect condition carefully and estimate value.',
  });

  assert.match(content, /# Autoresearch prompt/);
  assert.match(content, /Goal: Write a strong card valuation prompt/);
  assert.match(content, /Status: running/);
  assert.match(content, /Iteration: 4\/10/);
  assert.match(content, /Inspect condition carefully and estimate value/);
});
