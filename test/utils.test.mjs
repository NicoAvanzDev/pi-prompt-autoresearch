import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampIterations,
  clampEvalCaseCount,
  clampBenchmarkRuns,
  mean,
  variance,
  computeRelativeImprovement,
  formatSignedPercent,
  formatScore,
  makeProgressBar,
  clampProgress,
  parseAutoresearchArgs,
  parseBenchmarkArgs,
  summarizeGoal,
  formatDuration,
  estimateRemainingMs,
  countConsecutiveDiscards,
  earlyExitThreshold,
  shouldSkipComparison,
} from '../utils.ts';

test('clamp helpers enforce bounds', () => {
  assert.equal(clampIterations(0), 1);
  assert.equal(clampIterations(10.9), 10);
  assert.equal(clampIterations(999), 100);

  assert.equal(clampEvalCaseCount(1), 3);
  assert.equal(clampEvalCaseCount(5.8), 5);
  assert.equal(clampEvalCaseCount(99), 8);

  assert.equal(clampBenchmarkRuns(0), 1);
  assert.equal(clampBenchmarkRuns(3.9), 3);
  assert.equal(clampBenchmarkRuns(99), 10);
});

test('mean and variance handle common cases', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([10, 20, 30]), 20);
  assert.equal(variance([]), 0);
  assert.equal(variance([5, 5, 5]), 0);
  assert.equal(variance([0, 10]), 25);
});

test('relative improvement handles normal and edge cases', () => {
  assert.equal(computeRelativeImprovement(84, 50), 68);
  assert.equal(computeRelativeImprovement(50, 50), 0);
  assert.equal(computeRelativeImprovement(undefined, 50), undefined);
  assert.equal(computeRelativeImprovement(10, undefined), undefined);
  assert.equal(computeRelativeImprovement(0, 0), 0);
  assert.equal(computeRelativeImprovement(10, 0), undefined);
});

test('formatting helpers produce readable values', () => {
  assert.equal(formatSignedPercent(12.34), '+12.3%');
  assert.equal(formatSignedPercent(-2.04), '-2.0%');
  assert.equal(formatSignedPercent(undefined), '—');

  assert.equal(formatScore(88.88), '88.9');
  assert.equal(formatScore(undefined), '—');
});

test('progress helpers clamp and render bars', () => {
  assert.equal(clampProgress(-1), 0);
  assert.equal(clampProgress(2), 1);
  assert.equal(clampProgress(0.25), 0.25);

  assert.equal(makeProgressBar(0, 4), '[░░░░] 0%');
  assert.equal(makeProgressBar(0.5, 4), '[██░░] 50%');
  assert.equal(makeProgressBar(2, 4), '[████] 100%');
});

test('argument parsers understand inline overrides', () => {
  assert.deepEqual(
    parseAutoresearchArgs('--iterations 20 Build a better summarizer', 10),
    { iterations: 20, goal: 'Build a better summarizer' },
  );
  assert.deepEqual(
    parseAutoresearchArgs('  Improve JSON extraction  ', 7),
    { iterations: 7, goal: 'Improve JSON extraction' },
  );
  assert.deepEqual(
    parseAutoresearchArgs('--iterations 500 Stress test', 10),
    { iterations: 100, goal: 'Stress test' },
  );

  assert.deepEqual(
    parseBenchmarkArgs('--runs 5 Benchmark this prompt'),
    { runs: 5, goal: 'Benchmark this prompt' },
  );
  assert.deepEqual(
    parseBenchmarkArgs('  Benchmark this prompt  '),
    { runs: 3, goal: 'Benchmark this prompt' },
  );
  assert.deepEqual(
    parseBenchmarkArgs('--runs 50 Benchmark this prompt'),
    { runs: 10, goal: 'Benchmark this prompt' },
  );
});

test('summarizeGoal creates a compact single-line summary', () => {
  assert.equal(summarizeGoal('  Improve   extraction\nfor   JSON   payloads '), 'Improve extraction for JSON payloads');
  const long = 'a'.repeat(120);
  const summary = summarizeGoal(long, 20);
  assert.equal(summary.length, 20);
  assert.ok(summary.endsWith('…'));
});

test('duration and ETA helpers format human-readable timing', () => {
  assert.equal(formatDuration(undefined), '—');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(3_661_000), '1h 1m 1s');

  assert.equal(estimateRemainingMs(undefined, 0.5), undefined);
  assert.equal(estimateRemainingMs(10_000, 0), undefined);
  assert.equal(estimateRemainingMs(10_000, 1), 0);
  assert.equal(Math.round(estimateRemainingMs(10_000, 0.5)), 10_000);
});

test('countConsecutiveDiscards counts trailing false values', () => {
  assert.equal(countConsecutiveDiscards([]), 0);
  assert.equal(countConsecutiveDiscards([true]), 0);
  assert.equal(countConsecutiveDiscards([false]), 1);
  assert.equal(countConsecutiveDiscards([true, false, false, false]), 3);
  assert.equal(countConsecutiveDiscards([false, false, true, false, false]), 2);
  assert.equal(countConsecutiveDiscards([false, false, false]), 3);
  assert.equal(countConsecutiveDiscards([true, true, true]), 0);
  assert.equal(countConsecutiveDiscards([true, false, true]), 0);
});

test('earlyExitThreshold scales with iteration count', () => {
  assert.equal(earlyExitThreshold(1), 3);
  assert.equal(earlyExitThreshold(5), 3);
  assert.equal(earlyExitThreshold(10), 4);
  assert.equal(earlyExitThreshold(20), 8);
  assert.equal(earlyExitThreshold(100), 40);
});

test('shouldSkipComparison returns true when candidate clearly loses', () => {
  // Candidate scored well below best
  assert.equal(shouldSkipComparison(40, 60, true), true);
  // Candidate scored just below threshold (60 - 10 = 50, candidate is 50 -> not below)
  assert.equal(shouldSkipComparison(50, 60, true), false);
  // Candidate scored above best
  assert.equal(shouldSkipComparison(70, 60, true), false);
  // Equal score
  assert.equal(shouldSkipComparison(60, 60, true), false);
  // Evaluator recommended discard (keep=false)
  assert.equal(shouldSkipComparison(70, 60, false), true);
  // Custom threshold
  assert.equal(shouldSkipComparison(55, 60, true, 3), true);
  assert.equal(shouldSkipComparison(58, 60, true, 3), false);
});
