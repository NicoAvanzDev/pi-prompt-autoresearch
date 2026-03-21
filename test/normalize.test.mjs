import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	clampScore,
	shorten,
	trimJsonFence,
	extractJsonObject,
	asStringArray,
	throwIfAborted,
	normalizeCaseEvaluation,
	normalizePromptEvaluation,
	normalizeComparatorResult,
	normalizeGenerator,
	normalizeEvalCases,
	countAttemptResults,
} from "../normalize.ts";

describe("clampScore", () => {
	it("clamps values to 0–100 range", () => {
		assert.equal(clampScore(50), 50);
		assert.equal(clampScore(-10), 0);
		assert.equal(clampScore(200), 100);
		assert.equal(clampScore(0), 0);
		assert.equal(clampScore(100), 100);
	});

	it("returns 0 for non-finite values", () => {
		assert.equal(clampScore(NaN), 0);
		assert.equal(clampScore(Infinity), 0);
		assert.equal(clampScore(-Infinity), 0);
	});
});

describe("shorten", () => {
	it("returns text unchanged when under the limit", () => {
		assert.equal(shorten("hello", 100), "hello");
	});

	it("truncates text and appends notice", () => {
		const result = shorten("abcdef", 3);
		assert.ok(result.startsWith("abc"));
		assert.ok(result.includes("[truncated 3 chars]"));
	});

	it("uses default limit of 1200", () => {
		const longText = "x".repeat(1300);
		const result = shorten(longText);
		assert.ok(result.includes("[truncated 100 chars]"));
	});
});

describe("trimJsonFence", () => {
	it("strips markdown JSON fences", () => {
		assert.equal(trimJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
	});

	it("strips fences without json language tag", () => {
		assert.equal(trimJsonFence('```\n{"a":1}\n```'), '{"a":1}');
	});

	it("trims plain text", () => {
		assert.equal(trimJsonFence('  {"a":1}  '), '{"a":1}');
	});
});

describe("extractJsonObject", () => {
	it("parses clean JSON", () => {
		const result = extractJsonObject('{"key":"value"}');
		assert.deepEqual(result, { key: "value" });
	});

	it("parses JSON from fenced block", () => {
		const result = extractJsonObject('```json\n{"key":"value"}\n```');
		assert.deepEqual(result, { key: "value" });
	});

	it("extracts JSON embedded in surrounding text", () => {
		const result = extractJsonObject('Here is the result: {"key":"value"} and some trailing text');
		assert.deepEqual(result, { key: "value" });
	});

	it("throws on non-JSON text", () => {
		assert.throws(() => extractJsonObject("not json at all"), /Could not parse JSON/);
	});
});

describe("asStringArray", () => {
	it("converts array items to strings", () => {
		assert.deepEqual(asStringArray(["a", 1, true]), ["a", "1", "true"]);
	});

	it("returns empty array for non-array input", () => {
		assert.deepEqual(asStringArray(null), []);
		assert.deepEqual(asStringArray(undefined), []);
		assert.deepEqual(asStringArray("string"), []);
		assert.deepEqual(asStringArray(42), []);
	});
});

describe("throwIfAborted", () => {
	it("does nothing with no signal", () => {
		assert.doesNotThrow(() => throwIfAborted());
		assert.doesNotThrow(() => throwIfAborted(undefined));
	});

	it("does nothing with a non-aborted signal", () => {
		const controller = new AbortController();
		assert.doesNotThrow(() => throwIfAborted(controller.signal));
	});

	it("throws with an aborted signal", () => {
		const controller = new AbortController();
		controller.abort();
		assert.throws(() => throwIfAborted(controller.signal), /aborted/);
	});
});

describe("normalizeCaseEvaluation", () => {
	it("normalizes a well-formed evaluation", () => {
		const input = {
			caseId: "c1",
			title: "Test Case",
			score: 85,
			summary: "Good result",
			strengths: ["fast"],
			weaknesses: ["verbose"],
		};
		const result = normalizeCaseEvaluation(input, "fallback-id", "Fallback Title");
		assert.equal(result.caseId, "c1");
		assert.equal(result.title, "Test Case");
		assert.equal(result.score, 85);
		assert.equal(result.summary, "Good result");
		assert.deepEqual(result.strengths, ["fast"]);
		assert.deepEqual(result.weaknesses, ["verbose"]);
	});

	it("uses fallbacks for missing fields", () => {
		const result = normalizeCaseEvaluation({}, "fb-id", "FB Title");
		assert.equal(result.caseId, "fb-id");
		assert.equal(result.title, "FB Title");
		assert.equal(result.score, 0);
		assert.equal(result.summary, "No summary provided.");
		assert.deepEqual(result.strengths, []);
		assert.deepEqual(result.weaknesses, []);
	});

	it("uses fallbacks for null/undefined input", () => {
		const result = normalizeCaseEvaluation(null, "fb-id", "FB Title");
		assert.equal(result.caseId, "fb-id");
		assert.equal(result.score, 0);
	});

	it("clamps out-of-range scores", () => {
		assert.equal(normalizeCaseEvaluation({ score: 150 }, "x", "X").score, 100);
		assert.equal(normalizeCaseEvaluation({ score: -10 }, "x", "X").score, 0);
	});
});

describe("normalizePromptEvaluation", () => {
	const cases = [
		{ id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] },
		{ id: "c2", title: "Case 2", input: "input2", expectedCharacteristics: [] },
	];

	it("normalizes a well-formed evaluation", () => {
		const input = {
			score: 72,
			keep: true,
			summary: "Solid prompt",
			strengths: ["clear"],
			weaknesses: ["long"],
			suggestions: ["shorten"],
			caseEvaluations: [
				{ caseId: "c1", title: "Case 1", score: 80, summary: "ok", strengths: [], weaknesses: [] },
				{ caseId: "c2", title: "Case 2", score: 64, summary: "fair", strengths: [], weaknesses: [] },
			],
		};
		const result = normalizePromptEvaluation(input, cases);
		assert.equal(result.score, 72);
		assert.equal(result.keep, true);
		assert.equal(result.decision, "keep");
		assert.equal(result.caseEvaluations.length, 2);
		assert.equal(result.caseEvaluations[0].score, 80);
	});

	it("sets decision to discard when keep is false", () => {
		const result = normalizePromptEvaluation({ keep: false }, cases);
		assert.equal(result.decision, "discard");
	});

	it("handles missing caseEvaluations by using fallback titles/ids", () => {
		const result = normalizePromptEvaluation({}, cases);
		assert.equal(result.caseEvaluations.length, 2);
		assert.equal(result.caseEvaluations[0].caseId, "c1");
		assert.equal(result.caseEvaluations[1].title, "Case 2");
	});
});

describe("normalizeComparatorResult", () => {
	const cases = [
		{ id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] },
	];

	it("normalizes a valid comparator result", () => {
		const input = {
			winner: "A",
			summary: "A is better",
			reasons: ["clearer"],
			caseDecisions: [
				{ caseId: "c1", title: "Case 1", winner: "A", reason: "clearer output" },
			],
		};
		const result = normalizeComparatorResult(input, cases);
		assert.equal(result.winner, "A");
		assert.equal(result.keepCandidate, false);
		assert.equal(result.caseDecisions.length, 1);
		assert.equal(result.caseDecisions[0].winner, "A");
	});

	it("sets keepCandidate true when winner is B", () => {
		const result = normalizeComparatorResult({ winner: "B" }, cases);
		assert.equal(result.keepCandidate, true);
	});

	it("defaults to tie for invalid winner values", () => {
		const result = normalizeComparatorResult({ winner: "invalid" }, cases);
		assert.equal(result.winner, "tie");
		assert.equal(result.keepCandidate, false);
	});

	it("defaults case decisions to tie for missing data", () => {
		const result = normalizeComparatorResult({}, cases);
		assert.equal(result.caseDecisions[0].winner, "tie");
		assert.equal(result.caseDecisions[0].reason, "No reason provided.");
	});
});

describe("normalizeGenerator", () => {
	it("normalizes valid generator output", () => {
		const input = {
			candidatePrompt: "Do something better",
			changeSummary: "Improved clarity",
			hypothesis: "Clearer prompts produce better outputs",
		};
		const result = normalizeGenerator(input);
		assert.equal(result.candidatePrompt, "Do something better");
		assert.equal(result.changeSummary, "Improved clarity");
		assert.equal(result.hypothesis, "Clearer prompts produce better outputs");
	});

	it("throws on empty candidatePrompt", () => {
		assert.throws(() => normalizeGenerator({ candidatePrompt: "" }), /empty candidatePrompt/);
		assert.throws(() => normalizeGenerator({}), /empty candidatePrompt/);
	});

	it("trims whitespace from candidatePrompt", () => {
		const result = normalizeGenerator({ candidatePrompt: "  hello  " });
		assert.equal(result.candidatePrompt, "hello");
	});

	it("uses default messages for missing optional fields", () => {
		const result = normalizeGenerator({ candidatePrompt: "test" });
		assert.equal(result.changeSummary, "No change summary provided.");
		assert.equal(result.hypothesis, "No hypothesis provided.");
	});
});

describe("normalizeEvalCases", () => {
	it("normalizes valid eval cases", () => {
		const input = {
			cases: [
				{ id: "c1", title: "Case 1", input: "test input", expectedCharacteristics: ["fast"] },
			],
		};
		const result = normalizeEvalCases(input);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "c1");
		assert.equal(result[0].input, "test input");
		assert.deepEqual(result[0].expectedCharacteristics, ["fast"]);
	});

	it("filters out cases with empty input", () => {
		const input = {
			cases: [
				{ id: "c1", title: "Good", input: "has input", expectedCharacteristics: [] },
				{ id: "c2", title: "Bad", input: "", expectedCharacteristics: [] },
				{ id: "c3", title: "Whitespace", input: "   ", expectedCharacteristics: [] },
			],
		};
		const result = normalizeEvalCases(input);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "c1");
	});

	it("throws when no valid cases remain", () => {
		assert.throws(() => normalizeEvalCases({ cases: [] }), /No valid eval cases/);
		assert.throws(() => normalizeEvalCases({}), /No valid eval cases/);
	});

	it("generates fallback ids and titles", () => {
		const input = {
			cases: [{ input: "test" }],
		};
		const result = normalizeEvalCases(input);
		assert.equal(result[0].id, "case-1");
		assert.equal(result[0].title, "Case 1");
	});
});

describe("countAttemptResults", () => {
	it("counts accepted and discarded attempts", () => {
		const attempts = [
			{ accepted: true },
			{ accepted: false },
			{ accepted: true },
			{ accepted: false },
			{ accepted: false },
		];
		const result = countAttemptResults(attempts);
		assert.equal(result.acceptedCount, 2);
		assert.equal(result.discardedCount, 3);
	});

	it("handles empty array", () => {
		const result = countAttemptResults([]);
		assert.equal(result.acceptedCount, 0);
		assert.equal(result.discardedCount, 0);
	});

	it("handles all accepted", () => {
		const result = countAttemptResults([{ accepted: true }, { accepted: true }]);
		assert.equal(result.acceptedCount, 2);
		assert.equal(result.discardedCount, 0);
	});
});
