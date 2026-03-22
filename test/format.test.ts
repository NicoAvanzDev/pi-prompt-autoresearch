import { describe, it, expect } from "vitest";
import {
  buildHistorySummary,
  buildExecutionPrompt,
  buildRunSummaryMessage,
  buildBenchmarkSummaryMessage,
  shorten,
} from "../format.ts";
import type { AttemptRecord } from "../types.ts";

// Helper to create a minimal AttemptRecord-like object
function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    iteration: 1,
    candidatePrompt: "test prompt",
    evaluation: {
      score: 75,
      keep: true,
      decision: "keep",
      summary: "Good",
      strengths: [],
      weaknesses: [],
      suggestions: [],
      caseEvaluations: [],
    },
    comparison: {
      winner: "B",
      keepCandidate: true,
      summary: "B wins",
      reasons: [],
      caseDecisions: [],
    },
    accepted: true,
    changeSummary: "Improved clarity",
    hypothesis: "Clearer is better",
    ...overrides,
  };
}

describe("shorten (re-exported)", () => {
  it("re-exports shorten from normalize", () => {
    expect(typeof shorten).toBe("function");
    expect(shorten("short")).toBe("short");
  });
});

describe("buildHistorySummary", () => {
  it("returns placeholder for empty attempts", () => {
    expect(buildHistorySummary([])).toBe("No prior iterations yet.");
  });

  it("includes iteration details for each attempt", () => {
    const attempts = [
      makeAttempt({ iteration: 1 }),
      makeAttempt({ iteration: 2, accepted: false }),
    ];
    const result = buildHistorySummary(attempts);
    expect(result).toContain("Iteration 1: accepted");
    expect(result).toContain("Iteration 2: discarded");
    expect(result).toContain("Score: 75.0");
    expect(result).toContain("Improved clarity");
    expect(result).toContain("Clearer is better");
  });

  it("limits to last 6 attempts", () => {
    const attempts = Array.from({ length: 10 }, (_, i) => makeAttempt({ iteration: i + 1 }));
    const result = buildHistorySummary(attempts);
    // Should not include iteration 1-4 (only 5-10)
    expect(result).not.toContain("Iteration 1:");
    expect(result).not.toContain("Iteration 4:");
    expect(result).toContain("Iteration 5:");
    expect(result).toContain("Iteration 10:");
  });
});

describe("buildExecutionPrompt", () => {
  it("builds a structured prompt with test case", () => {
    const evalCase = {
      id: "c1",
      title: "Basic Test",
      input: "What is 2+2?",
      expectedCharacteristics: [] as string[],
    };
    const result = buildExecutionPrompt("Be a calculator", evalCase);
    expect(result).toContain("PROMPT UNDER TEST:");
    expect(result).toContain("Be a calculator");
    expect(result).toContain("TEST CASE: Basic Test");
    expect(result).toContain("TEST INPUT:");
    expect(result).toContain("What is 2+2?");
  });
});

describe("buildRunSummaryMessage", () => {
  it("builds a complete run summary", () => {
    const evalCases = [
      { id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] as string[] },
    ];
    const summary = {
      goal: "Improve math prompts",
      iterations: 5,
      evalCases,
      baseline: {
        prompt: "original",
        outputs: [] as string[],
        evaluation: {
          score: 60,
          keep: true,
          decision: "keep" as const,
          summary: "Baseline",
          strengths: [] as string[],
          weaknesses: [] as string[],
          suggestions: [] as string[],
          caseEvaluations: [
            {
              caseId: "c1",
              title: "Case 1",
              score: 60,
              summary: "ok",
              strengths: [] as string[],
              weaknesses: [] as string[],
            },
          ],
        },
      },
      best: {
        prompt: "improved",
        outputs: [] as string[],
        evaluation: {
          score: 85,
          keep: true,
          decision: "keep" as const,
          summary: "Great",
          strengths: [] as string[],
          weaknesses: [] as string[],
          suggestions: [] as string[],
          caseEvaluations: [
            {
              caseId: "c1",
              title: "Case 1",
              score: 85,
              summary: "great",
              strengths: [] as string[],
              weaknesses: [] as string[],
            },
          ],
        },
      },
      attempts: [
        makeAttempt({ iteration: 1, accepted: true }),
        makeAttempt({ iteration: 2, accepted: false }),
        makeAttempt({ iteration: 3, accepted: true }),
      ],
    };
    const result = buildRunSummaryMessage(summary);
    expect(result).toContain("# Prompt autoresearch result");
    expect(result).toContain("Goal: Improve math prompts");
    expect(result).toContain("Iterations: 5");
    expect(result).toContain("Baseline score: 60.0");
    expect(result).toContain("Best score: 85.0");
    expect(result).toContain("Accepted: 2");
    expect(result).toContain("Discarded: 1");
    expect(result).toContain("## Eval suite");
    expect(result).toContain("Case 1: 85.0");
    expect(result).toContain("AUTORESEARCH_PROMPT.md");
    expect(result).not.toContain("## Best prompt");
    expect(result).not.toContain("improved");
    expect(result).toContain("## Iteration log");
    expect(result).toContain("Iteration 1: kept");
    expect(result).toContain("Iteration 2: discarded");
  });
});

describe("buildBenchmarkSummaryMessage", () => {
  it("builds a complete benchmark summary", () => {
    const summary = {
      goal: "Test stability",
      prompt: "Be consistent",
      evalCases: [
        { id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] as string[] },
      ],
      runs: [
        { runIndex: 1, score: 80, summary: "Good run" },
        { runIndex: 2, score: 75, summary: "Decent run" },
        { runIndex: 3, score: 85, summary: "Great run" },
      ],
      meanScore: 80,
      minScore: 75,
      maxScore: 85,
      variance: 16.67,
      stddev: 4.08,
    };
    const result = buildBenchmarkSummaryMessage(summary);
    expect(result).toContain("# Prompt benchmark result");
    expect(result).toContain("Goal: Test stability");
    expect(result).toContain("Runs: 3");
    expect(result).toContain("Mean score: 80.0");
    expect(result).toContain("Min score: 75.0");
    expect(result).toContain("Max score: 85.0");
    expect(result).toContain("Variance: 16.67");
    expect(result).toContain("Stddev: 4.08");
    expect(result).not.toContain("## Prompt");
    expect(result).not.toContain("Be consistent");
    expect(result).toContain("## Runs");
    expect(result).toContain("Run 1: 80.0 | Good run");
    expect(result).toContain("Run 3: 85.0 | Great run");
  });
});
