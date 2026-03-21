import { describe, it, expect } from "vitest";
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
  it("clamps values to 0-100 range", () => {
    expect(clampScore(50)).toBe(50);
    expect(clampScore(-10)).toBe(0);
    expect(clampScore(200)).toBe(100);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(100)).toBe(100);
  });

  it("returns 0 for non-finite values", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
    expect(clampScore(-Infinity)).toBe(0);
  });
});

describe("shorten", () => {
  it("returns text unchanged when under the limit", () => {
    expect(shorten("hello", 100)).toBe("hello");
  });

  it("truncates text and appends notice", () => {
    const result = shorten("abcdef", 3);
    expect(result.startsWith("abc")).toBe(true);
    expect(result).toContain("[truncated 3 chars]");
  });

  it("uses default limit of 1200", () => {
    const longText = "x".repeat(1300);
    const result = shorten(longText);
    expect(result).toContain("[truncated 100 chars]");
  });
});

describe("trimJsonFence", () => {
  it("strips markdown JSON fences", () => {
    expect(trimJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips fences without json language tag", () => {
    expect(trimJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("trims plain text", () => {
    expect(trimJsonFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("extractJsonObject", () => {
  it("parses clean JSON", () => {
    expect(extractJsonObject('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("parses JSON from fenced block", () => {
    expect(extractJsonObject('```json\n{"key":"value"}\n```')).toEqual({ key: "value" });
  });

  it("extracts JSON embedded in surrounding text", () => {
    expect(extractJsonObject('Here is the result: {"key":"value"} and some trailing text')).toEqual(
      {
        key: "value",
      },
    );
  });

  it("throws on non-JSON text", () => {
    expect(() => extractJsonObject("not json at all")).toThrow(/Could not parse JSON/);
  });
});

describe("asStringArray", () => {
  it("converts array items to strings", () => {
    expect(asStringArray(["a", 1, true])).toEqual(["a", "1", "true"]);
  });

  it("returns empty array for non-array input", () => {
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray("string")).toEqual([]);
    expect(asStringArray(42)).toEqual([]);
  });
});

describe("throwIfAborted", () => {
  it("does nothing with no signal", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("does nothing with a non-aborted signal", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("throws with an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(/aborted/);
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
    expect(result.caseId).toBe("c1");
    expect(result.title).toBe("Test Case");
    expect(result.score).toBe(85);
    expect(result.summary).toBe("Good result");
    expect(result.strengths).toEqual(["fast"]);
    expect(result.weaknesses).toEqual(["verbose"]);
  });

  it("uses fallbacks for missing fields", () => {
    const result = normalizeCaseEvaluation({}, "fb-id", "FB Title");
    expect(result.caseId).toBe("fb-id");
    expect(result.title).toBe("FB Title");
    expect(result.score).toBe(0);
    expect(result.summary).toBe("No summary provided.");
    expect(result.strengths).toEqual([]);
    expect(result.weaknesses).toEqual([]);
  });

  it("uses fallbacks for null/undefined input", () => {
    const result = normalizeCaseEvaluation(null, "fb-id", "FB Title");
    expect(result.caseId).toBe("fb-id");
    expect(result.score).toBe(0);
  });

  it("clamps out-of-range scores", () => {
    expect(normalizeCaseEvaluation({ score: 150 }, "x", "X").score).toBe(100);
    expect(normalizeCaseEvaluation({ score: -10 }, "x", "X").score).toBe(0);
  });
});

describe("normalizePromptEvaluation", () => {
  const cases = [
    { id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] as string[] },
    { id: "c2", title: "Case 2", input: "input2", expectedCharacteristics: [] as string[] },
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
        {
          caseId: "c2",
          title: "Case 2",
          score: 64,
          summary: "fair",
          strengths: [],
          weaknesses: [],
        },
      ],
    };
    const result = normalizePromptEvaluation(input, cases);
    expect(result.score).toBe(72);
    expect(result.keep).toBe(true);
    expect(result.decision).toBe("keep");
    expect(result.caseEvaluations).toHaveLength(2);
    expect(result.caseEvaluations[0].score).toBe(80);
  });

  it("sets decision to discard when keep is false", () => {
    const result = normalizePromptEvaluation({ keep: false }, cases);
    expect(result.decision).toBe("discard");
  });

  it("handles missing caseEvaluations by using fallback titles/ids", () => {
    const result = normalizePromptEvaluation({}, cases);
    expect(result.caseEvaluations).toHaveLength(2);
    expect(result.caseEvaluations[0].caseId).toBe("c1");
    expect(result.caseEvaluations[1].title).toBe("Case 2");
  });
});

describe("normalizeComparatorResult", () => {
  const cases = [
    { id: "c1", title: "Case 1", input: "input1", expectedCharacteristics: [] as string[] },
  ];

  it("normalizes a valid comparator result", () => {
    const input = {
      winner: "A",
      summary: "A is better",
      reasons: ["clearer"],
      caseDecisions: [{ caseId: "c1", title: "Case 1", winner: "A", reason: "clearer output" }],
    };
    const result = normalizeComparatorResult(input, cases);
    expect(result.winner).toBe("A");
    expect(result.keepCandidate).toBe(false);
    expect(result.caseDecisions).toHaveLength(1);
    expect(result.caseDecisions[0].winner).toBe("A");
  });

  it("sets keepCandidate true when winner is B", () => {
    const result = normalizeComparatorResult({ winner: "B" }, cases);
    expect(result.keepCandidate).toBe(true);
  });

  it("defaults to tie for invalid winner values", () => {
    const result = normalizeComparatorResult({ winner: "invalid" }, cases);
    expect(result.winner).toBe("tie");
    expect(result.keepCandidate).toBe(false);
  });

  it("defaults case decisions to tie for missing data", () => {
    const result = normalizeComparatorResult({}, cases);
    expect(result.caseDecisions[0].winner).toBe("tie");
    expect(result.caseDecisions[0].reason).toBe("No reason provided.");
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
    expect(result.candidatePrompt).toBe("Do something better");
    expect(result.changeSummary).toBe("Improved clarity");
    expect(result.hypothesis).toBe("Clearer prompts produce better outputs");
  });

  it("throws on empty candidatePrompt", () => {
    expect(() => normalizeGenerator({ candidatePrompt: "" })).toThrow(/empty candidatePrompt/);
    expect(() => normalizeGenerator({})).toThrow(/empty candidatePrompt/);
  });

  it("trims whitespace from candidatePrompt", () => {
    const result = normalizeGenerator({ candidatePrompt: "  hello  " });
    expect(result.candidatePrompt).toBe("hello");
  });

  it("uses default messages for missing optional fields", () => {
    const result = normalizeGenerator({ candidatePrompt: "test" });
    expect(result.changeSummary).toBe("No change summary provided.");
    expect(result.hypothesis).toBe("No hypothesis provided.");
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
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
    expect(result[0].input).toBe("test input");
    expect(result[0].expectedCharacteristics).toEqual(["fast"]);
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
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
  });

  it("throws when no valid cases remain", () => {
    expect(() => normalizeEvalCases({ cases: [] })).toThrow(/No valid eval cases/);
    expect(() => normalizeEvalCases({})).toThrow(/No valid eval cases/);
  });

  it("generates fallback ids and titles", () => {
    const input = {
      cases: [{ input: "test" }],
    };
    const result = normalizeEvalCases(input);
    expect(result[0].id).toBe("case-1");
    expect(result[0].title).toBe("Case 1");
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
    expect(result.acceptedCount).toBe(2);
    expect(result.discardedCount).toBe(3);
  });

  it("handles empty array", () => {
    const result = countAttemptResults([]);
    expect(result.acceptedCount).toBe(0);
    expect(result.discardedCount).toBe(0);
  });

  it("handles all accepted", () => {
    const result = countAttemptResults([{ accepted: true }, { accepted: true }]);
    expect(result.acceptedCount).toBe(2);
    expect(result.discardedCount).toBe(0);
  });
});
