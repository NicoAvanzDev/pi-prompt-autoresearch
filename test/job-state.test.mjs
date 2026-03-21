import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySnapshotPatch,
  completeSnapshot,
  createInitialJobSnapshot,
  enterPaused,
  failSnapshot,
  getStatusText,
  killSnapshot,
  resumeSnapshot,
  requestPause,
} from '../job-state.ts';

test('createInitialJobSnapshot builds a running job', () => {
  const snapshot = createInitialJobSnapshot({
    goal: 'Improve summarization',
    goalSummary: 'Improve summarization',
    bestPrompt: 'Initial prompt body',
    iterations: 12,
    evalCaseCount: 5,
    now: 123,
  });

  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.goal, 'Improve summarization');
  assert.equal(snapshot.goalSummary, 'Improve summarization');
  assert.equal(snapshot.bestPrompt, 'Initial prompt body');
  assert.equal(snapshot.currentIteration, 0);
  assert.equal(snapshot.totalIterations, 12);
  assert.equal(snapshot.totalCases, 5);
  assert.equal(snapshot.startedAt, 123);
  assert.equal(snapshot.updatedAt, 123);
});

test('applySnapshotPatch merges fields and updates timestamp', () => {
  const initial = createInitialJobSnapshot({ goal: 'X', iterations: 2, evalCaseCount: 5, now: 10 });
  const updated = applySnapshotPatch(initial, { currentIteration: 1, phase: 'run-eval-suite' }, 20);

  assert.equal(updated.currentIteration, 1);
  assert.equal(updated.phase, 'run-eval-suite');
  assert.equal(updated.updatedAt, 20);
  assert.equal(updated.startedAt, 10);
});

test('pause, resume, and kill transitions update status and messages', () => {
  const initial = createInitialJobSnapshot({ goal: 'X', iterations: 2, evalCaseCount: 5, now: 10 });
  const pauseRequested = requestPause(initial, 11);
  assert.equal(pauseRequested.status, 'pause-requested');
  assert.match(pauseRequested.message, /Pause requested/);

  const paused = enterPaused({ ...pauseRequested, phase: 'compare-a-b' }, 12);
  assert.equal(paused.status, 'paused');
  assert.match(paused.message, /compare-a-b/);

  const resumed = resumeSnapshot(paused, 13);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.message, 'Resuming autoresearch...');

  const killed = killSnapshot(resumed, 14);
  assert.equal(killed.status, 'killed');
  assert.equal(killed.phase, 'killed');
  assert.match(killed.message, /Kill requested/);
});

test('complete and fail transitions preserve summary fields', () => {
  const initial = createInitialJobSnapshot({ goal: 'X', iterations: 4, evalCaseCount: 5, now: 10 });
  const completed = completeSnapshot(initial, {
    currentIteration: 4,
    currentScore: 88,
    bestScore: 91,
    acceptedCount: 2,
    discardedCount: 2,
    baselineScore: 50,
    bestPrompt: 'Best prompt body',
    overallImprovementPct: 82,
  }, 99);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.currentIteration, 4);
  assert.equal(completed.bestScore, 91);
  assert.equal(completed.bestPrompt, 'Best prompt body');
  assert.equal(completed.acceptedCount, 2);
  assert.equal(completed.updatedAt, 99);
  assert.match(completed.message, /Finished\. Best score 91.0/);

  const failed = failSnapshot(completed, 'boom', 100);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.updatedAt, 100);
  assert.equal(failed.message, 'Autoresearch failed: boom');
});

test('getStatusText renders readable status summaries', () => {
  const base = createInitialJobSnapshot({ goal: 'X', iterations: 3, evalCaseCount: 5, now: 10 });

  assert.equal(getStatusText({ ...base, currentIteration: 1, bestScore: 77 }), '● autoresearch · iter 1/3 · best 77.0');
  assert.equal(getStatusText({ ...base, status: 'paused', currentIteration: 2 }), '⏸ autoresearch paused · iter 2/3');
  assert.equal(getStatusText({ ...base, status: 'pause-requested' }), '⏸ autoresearch pausing after current step...');
  assert.equal(getStatusText({ ...base, status: 'completed', bestScore: 88 }), '✓ autoresearch complete · best 88.0');
  assert.equal(getStatusText({ ...base, status: 'killed' }), '■ autoresearch killed');
  assert.equal(getStatusText({ ...base, status: 'failed' }), '✗ autoresearch failed');
});
