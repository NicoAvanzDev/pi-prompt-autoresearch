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
