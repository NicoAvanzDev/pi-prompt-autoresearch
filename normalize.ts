import type {
	CaseEvaluation,
	ComparatorResult,
	EvalCase,
	GeneratorResult,
	PromptEvaluation,
} from "./types.ts";

const SHORTEN_FALLBACK_LIMIT = 500;

/** Clamp a score value to the 0–100 range. */
export function clampScore(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** Truncate text and append a truncation notice. */
export function shorten(text: string, maxLength = 1200): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n\n[truncated ${text.length - maxLength} chars]`;
}

/** Strip markdown JSON fences from model output. */
export function trimJsonFence(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	return text.trim();
}

/** Parse a JSON object from potentially messy model output. */
export function extractJsonObject(text: string): unknown {
	const cleaned = trimJsonFence(text);
	try {
		return JSON.parse(cleaned);
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
		throw new Error(`Could not parse JSON from model output:\n${shorten(cleaned, SHORTEN_FALLBACK_LIMIT)}`);
	}
}

/** Coerce an unknown value to a string array, discarding non-array input. */
export function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item));
}

/** Throw if an AbortSignal has already been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Autoresearch run was aborted.");
}

export function normalizeCaseEvaluation(value: unknown, fallbackId: string, fallbackTitle: string): CaseEvaluation {
	const v = value as Record<string, unknown> | null | undefined;
	const scoreNumber = Number(v?.score);
	return {
		caseId: String(v?.caseId ?? fallbackId),
		title: String(v?.title ?? fallbackTitle),
		score: clampScore(scoreNumber),
		summary: String(v?.summary ?? "No summary provided."),
		strengths: asStringArray(v?.strengths),
		weaknesses: asStringArray(v?.weaknesses),
	};
}

export function normalizePromptEvaluation(value: unknown, cases: EvalCase[]): PromptEvaluation {
	const v = value as Record<string, unknown> | null | undefined;
	const scoreNumber = Number(v?.score);
	const keep = Boolean(v?.keep);
	const caseValues = Array.isArray(v?.caseEvaluations) ? (v.caseEvaluations as unknown[]) : [];
	const caseEvaluations = cases.map((evalCase, index) =>
		normalizeCaseEvaluation(caseValues[index], evalCase.id, evalCase.title),
	);
	return {
		score: clampScore(scoreNumber),
		keep,
		decision: keep ? "keep" : "discard",
		summary: String(v?.summary ?? "No summary provided."),
		strengths: asStringArray(v?.strengths),
		weaknesses: asStringArray(v?.weaknesses),
		suggestions: asStringArray(v?.suggestions),
		caseEvaluations,
	};
}

export function normalizeComparatorResult(value: unknown, cases: EvalCase[]): ComparatorResult {
	const v = value as Record<string, unknown> | null | undefined;
	const rawCaseDecisions = Array.isArray(v?.caseDecisions) ? (v.caseDecisions as unknown[]) : [];
	const caseDecisions = cases.map((evalCase, index) => {
		const raw = (rawCaseDecisions[index] ?? {}) as Record<string, unknown>;
		const winner = raw?.winner === "A" || raw?.winner === "B" || raw?.winner === "tie" ? raw.winner : "tie";
		return {
			caseId: String(raw?.caseId ?? evalCase.id),
			title: String(raw?.title ?? evalCase.title),
			winner,
			reason: String(raw?.reason ?? "No reason provided."),
		};
	});
	const winner = v?.winner === "A" || v?.winner === "B" || v?.winner === "tie" ? v.winner : "tie";
	return {
		winner,
		keepCandidate: winner === "B",
		summary: String(v?.summary ?? "No summary provided."),
		reasons: asStringArray(v?.reasons),
		caseDecisions,
	};
}

export function normalizeGenerator(value: unknown): GeneratorResult {
	const v = value as Record<string, unknown> | null | undefined;
	const candidatePrompt = String(v?.candidatePrompt ?? "").trim();
	if (!candidatePrompt) throw new Error("Generator returned an empty candidatePrompt.");
	return {
		candidatePrompt,
		changeSummary: String(v?.changeSummary ?? "No change summary provided."),
		hypothesis: String(v?.hypothesis ?? "No hypothesis provided."),
	};
}

export function normalizeEvalCases(value: unknown): EvalCase[] {
	const v = value as Record<string, unknown> | null | undefined;
	const rawCases = Array.isArray(v?.cases) ? (v.cases as unknown[]) : [];
	const cases = rawCases
		.map((item: unknown, index: number) => {
			const c = item as Record<string, unknown> | null | undefined;
			return {
				id: String(c?.id ?? `case-${index + 1}`),
				title: String(c?.title ?? `Case ${index + 1}`),
				input: String(c?.input ?? "").trim(),
				expectedCharacteristics: asStringArray(c?.expectedCharacteristics),
			};
		})
		.filter((item) => item.input.length > 0);
	if (cases.length === 0) throw new Error("No valid eval cases were generated.");
	return cases;
}

/** Count accepted vs discarded attempts. */
export function countAttemptResults(attempts: { accepted: boolean }[]): { acceptedCount: number; discardedCount: number } {
	const acceptedCount = attempts.filter((a) => a.accepted).length;
	return { acceptedCount, discardedCount: attempts.length - acceptedCount };
}
