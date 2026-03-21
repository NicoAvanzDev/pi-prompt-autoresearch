import { describe, it, expect } from "vitest";
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
} from "../utils.ts";

describe("clamp helpers", () => {
  it("enforce bounds", () => {
    expect(clampIterations(0)).toBe(1);
    expect(clampIterations(10.9)).toBe(10);
    expect(clampIterations(999)).toBe(100);

    expect(clampEvalCaseCount(1)).toBe(3);
    expect(clampEvalCaseCount(5.8)).toBe(5);
    expect(clampEvalCaseCount(99)).toBe(8);

    expect(clampBenchmarkRuns(0)).toBe(1);
    expect(clampBenchmarkRuns(3.9)).toBe(3);
    expect(clampBenchmarkRuns(99)).toBe(10);
  });
});

describe("mean and variance", () => {
  it("handle common cases", () => {
    expect(mean([])).toBe(0);
    expect(mean([10, 20, 30])).toBe(20);
    expect(variance([])).toBe(0);
    expect(variance([5, 5, 5])).toBe(0);
    expect(variance([0, 10])).toBe(25);
  });
});

describe("relative improvement", () => {
  it("handles normal and edge cases", () => {
    expect(computeRelativeImprovement(84, 50)).toBe(68);
    expect(computeRelativeImprovement(50, 50)).toBe(0);
    expect(computeRelativeImprovement(undefined, 50)).toBeUndefined();
    expect(computeRelativeImprovement(10, undefined)).toBeUndefined();
    expect(computeRelativeImprovement(0, 0)).toBe(0);
    expect(computeRelativeImprovement(10, 0)).toBeUndefined();
  });
});

describe("formatting helpers", () => {
  it("produce readable values", () => {
    expect(formatSignedPercent(12.34)).toBe("+12.3%");
    expect(formatSignedPercent(-2.04)).toBe("-2.0%");
    expect(formatSignedPercent(undefined)).toBe("—");

    expect(formatScore(88.88)).toBe("88.9");
    expect(formatScore(undefined)).toBe("—");
  });
});

describe("progress helpers", () => {
  it("clamp and render bars", () => {
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(2)).toBe(1);
    expect(clampProgress(0.25)).toBe(0.25);

    expect(makeProgressBar(0, 4)).toBe("[░░░░] 0%");
    expect(makeProgressBar(0.5, 4)).toBe("[██░░] 50%");
    expect(makeProgressBar(2, 4)).toBe("[████] 100%");
  });
});

describe("argument parsers", () => {
  it("understand inline overrides", () => {
    expect(parseAutoresearchArgs("--iterations 20 Build a better summarizer", 10)).toEqual({
      iterations: 20,
      goal: "Build a better summarizer",
    });
    expect(parseAutoresearchArgs("  Improve JSON extraction  ", 7)).toEqual({
      iterations: 7,
      goal: "Improve JSON extraction",
    });
    expect(parseAutoresearchArgs("--iterations 500 Stress test", 10)).toEqual({
      iterations: 100,
      goal: "Stress test",
    });

    expect(parseBenchmarkArgs("--runs 5 Benchmark this prompt")).toEqual({
      runs: 5,
      goal: "Benchmark this prompt",
    });
    expect(parseBenchmarkArgs("  Benchmark this prompt  ")).toEqual({
      runs: 3,
      goal: "Benchmark this prompt",
    });
    expect(parseBenchmarkArgs("--runs 50 Benchmark this prompt")).toEqual({
      runs: 10,
      goal: "Benchmark this prompt",
    });
  });
});

describe("summarizeGoal", () => {
  it("creates a compact single-line summary", () => {
    expect(summarizeGoal("  Improve   extraction\nfor   JSON   payloads ")).toBe(
      "Improve extraction for JSON payloads",
    );
    const long = "a".repeat(120);
    const summary = summarizeGoal(long, 20);
    expect(summary).toHaveLength(20);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("duration and ETA helpers", () => {
  it("format human-readable timing", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");

    expect(estimateRemainingMs(undefined, 0.5)).toBeUndefined();
    expect(estimateRemainingMs(10_000, 0)).toBeUndefined();
    expect(estimateRemainingMs(10_000, 1)).toBe(0);
    expect(Math.round(estimateRemainingMs(10_000, 0.5)!)).toBe(10_000);
  });
});

describe("countConsecutiveDiscards", () => {
  it("counts trailing false values", () => {
    expect(countConsecutiveDiscards([])).toBe(0);
    expect(countConsecutiveDiscards([true])).toBe(0);
    expect(countConsecutiveDiscards([false])).toBe(1);
    expect(countConsecutiveDiscards([true, false, false, false])).toBe(3);
    expect(countConsecutiveDiscards([false, false, true, false, false])).toBe(2);
    expect(countConsecutiveDiscards([false, false, false])).toBe(3);
    expect(countConsecutiveDiscards([true, true, true])).toBe(0);
    expect(countConsecutiveDiscards([true, false, true])).toBe(0);
  });
});

describe("earlyExitThreshold", () => {
  it("scales with iteration count", () => {
    expect(earlyExitThreshold(1)).toBe(3);
    expect(earlyExitThreshold(5)).toBe(3);
    expect(earlyExitThreshold(10)).toBe(4);
    expect(earlyExitThreshold(20)).toBe(8);
    expect(earlyExitThreshold(100)).toBe(40);
  });
});

describe("shouldSkipComparison", () => {
  it("returns true when candidate clearly loses", () => {
    // Candidate scored well below best
    expect(shouldSkipComparison(40, 60, true)).toBe(true);
    // Candidate scored just below threshold (60 - 10 = 50, candidate is 50 -> not below)
    expect(shouldSkipComparison(50, 60, true)).toBe(false);
    // Candidate scored above best
    expect(shouldSkipComparison(70, 60, true)).toBe(false);
    // Equal score
    expect(shouldSkipComparison(60, 60, true)).toBe(false);
    // Evaluator recommended discard (keep=false)
    expect(shouldSkipComparison(70, 60, false)).toBe(true);
    // Custom threshold
    expect(shouldSkipComparison(55, 60, true, 3)).toBe(true);
    expect(shouldSkipComparison(58, 60, true, 3)).toBe(false);
  });
});
