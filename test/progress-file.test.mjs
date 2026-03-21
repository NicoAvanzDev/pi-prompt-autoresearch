import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressFile, PROGRESS_FILE_NAME } from '../progress-file.ts';
import { createInitialJobSnapshot } from '../job-state.ts';

test('renderProgressFile includes recovery information and best prompt', () => {
  const snapshot = createInitialJobSnapshot({
    goal: 'Write a better summarization prompt for technical articles',
    goalSummary: 'Write a better summarization prompt for technical articles',
    bestPrompt: 'You are a concise summarizer.',
    iterations: 10,
    evalCaseCount: 5,
    now: Date.UTC(2026, 0, 1),
  });

  const content = renderProgressFile({
    ...snapshot,
    status: 'running',
    phase: 'run-eval-suite',
    currentIteration: 3,
    currentCaseIndex: 2,
    totalCases: 5,
    currentCaseTitle: 'Long article with edge cases',
    baselineScore: 55,
    currentScore: 72,
    bestScore: 75,
    overallImprovementPct: 36.4,
    lastAcceptedGainPct: 8.7,
    acceptedCount: 1,
    discardedCount: 1,
    message: 'Iteration 3/10: eval case 2/5',
  }, '/repo');

  assert.match(content, /# Autoresearch progress/);
  assert.match(content, /cwd: \/repo/);
  assert.match(content, /status: running/);
  assert.match(content, /current case: Long article with edge cases/);
  assert.match(content, /best score: 75.0/);
  assert.match(content, /You are a concise summarizer\./);
  assert.match(content, /Recovery notes/);
  assert.equal(PROGRESS_FILE_NAME, 'AUTORESEARCH_PROGRESS.md');
});
