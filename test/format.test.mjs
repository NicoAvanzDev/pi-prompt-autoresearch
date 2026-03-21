import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildHistorySummary,
	buildExecutionPrompt,
	buildRunSummaryMessage,
	buildBenchmarkSummaryMessage,
	shorten,
} from "../format.ts";

// Helper to create a minimal AttemptRecord-like object
function makeAttempt(overrides = {}) {
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
		assert.equal(typeof shorten, "function");
		assert.equal(shorten("short"), "short");
	});
});

describe("buildHistorySummary", () => {
	it("returns placeholder for empty attempts", () => {
		assert.equal(buildHistorySummary([]), "No prior iterations yet.");
	});

	it("includes iteration details for each attempt", () => {
		const attempts = [makeAttempt({ iteration: 1 }), makeAttempt({ iteration: 2, accepted: false })];
		const result = buildHistorySummary(attempts);
		assert.ok(result.includes("Iteration 1: accepted"));
		assert.ok(result.includes("Iteration 2: discarded"));
		assert.ok(result.includes("Score: 75.0"));
		assert.ok(result.includes("Improved clarity"));
		assert.ok(result.includes("Clearer is better"));
	});

	it("limits to last 6 attempts", () => {
		const attempts = Array.from({ length: 10 }, (_, i) => makeAttempt({ iteration: i + 1 }));
		const result = buildHistorySummary(attempts);
		// Should not include iteration 1-4 (only 5-10)
		assert.ok(!result.includes("Iteration 1:"));
		assert.ok(!result.includes("Iteration 4:"));
		assert.ok(result.includes("Iteration 5:"));
		assert.ok(result.includes("Iteration 10:"));
	});
});

describe("buildExecutionPrompt", () => {
	it("builds a structured prompt with test case", () => {
		const evalCase = { id: "c1", title: "Basic Test", input: "What is 2+2?", expectedCharacteristics: [] };
		const result = buildExecutionPrompt("Be a calculator", evalCase);
		assert.ok(result.includes("PROMPT UNDER TEST:"));
		assert.ok(result.includes("Be a calculator"));
		assert.ok(result.includes("TEST CASE: Basic Test"));
		assert.ok(result.includes("TEST INPUT:"));
		assert.ok(result.includes("What is 2+2?"));
	});
});

describe("buildRunSummaryMessage", () => {
	it("builds a complete run summary", () => {
		const evalCases = [
			{ id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] },
		];
		const summary = {
			goal: "Improve math prompts",
			iterations: 5,
			evalCases,
			baseline: {
				prompt: "original",
				outputs: [],
				evaluation: {
					score: 60,
					keep: true,
					decision: "keep",
					summary: "Baseline",
					strengths: [],
					weaknesses: [],
					suggestions: [],
					caseEvaluations: [{ caseId: "c1", title: "Case 1", score: 60, summary: "ok", strengths: [], weaknesses: [] }],
				},
			},
			best: {
				prompt: "improved",
				outputs: [],
				evaluation: {
					score: 85,
					keep: true,
					decision: "keep",
					summary: "Great",
					strengths: [],
					weaknesses: [],
					suggestions: [],
					caseEvaluations: [{ caseId: "c1", title: "Case 1", score: 85, summary: "great", strengths: [], weaknesses: [] }],
				},
			},
			attempts: [
				makeAttempt({ iteration: 1, accepted: true }),
				makeAttempt({ iteration: 2, accepted: false }),
				makeAttempt({ iteration: 3, accepted: true }),
			],
		};
		const result = buildRunSummaryMessage(summary);
		assert.ok(result.includes("# Prompt autoresearch result"));
		assert.ok(result.includes("Goal: Improve math prompts"));
		assert.ok(result.includes("Iterations: 5"));
		assert.ok(result.includes("Baseline score: 60.0"));
		assert.ok(result.includes("Best score: 85.0"));
		assert.ok(result.includes("Accepted: 2"));
		assert.ok(result.includes("Discarded: 1"));
		assert.ok(result.includes("## Eval suite"));
		assert.ok(result.includes("Case 1: 85.0"));
		assert.ok(result.includes("## Best prompt"));
		assert.ok(result.includes("improved"));
		assert.ok(result.includes("## Iteration log"));
		assert.ok(result.includes("Iteration 1: kept"));
		assert.ok(result.includes("Iteration 2: discarded"));
	});
});

describe("buildBenchmarkSummaryMessage", () => {
	it("builds a complete benchmark summary", () => {
		const summary = {
			goal: "Test stability",
			prompt: "Be consistent",
			evalCases: [{ id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] }],
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
		assert.ok(result.includes("# Prompt benchmark result"));
		assert.ok(result.includes("Goal: Test stability"));
		assert.ok(result.includes("Runs: 3"));
		assert.ok(result.includes("Mean score: 80.0"));
		assert.ok(result.includes("Min score: 75.0"));
		assert.ok(result.includes("Max score: 85.0"));
		assert.ok(result.includes("Variance: 16.67"));
		assert.ok(result.includes("Stddev: 4.08"));
		assert.ok(result.includes("## Prompt"));
		assert.ok(result.includes("Be consistent"));
		assert.ok(result.includes("## Runs"));
		assert.ok(result.includes("Run 1: 80.0 | Good run"));
		assert.ok(result.includes("Run 3: 85.0 | Great run"));
	});
});
