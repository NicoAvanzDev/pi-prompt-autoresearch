import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_ITERATIONS = 10;
const MAX_ITERATIONS = 100;
const DEFAULT_EVAL_CASES = 5;
const MAX_EVAL_CASES = 8;
const DEFAULT_BENCHMARK_RUNS = 3;
const MAX_BENCHMARK_RUNS = 10;
const RESULT_PREVIEW_LIMIT = 1200;
const HISTORY_PREVIEW_LIMIT = 6;

interface GeneratorResult {
	candidatePrompt: string;
	changeSummary: string;
	hypothesis: string;
}

interface EvalCase {
	id: string;
	title: string;
	input: string;
	expectedCharacteristics: string[];
}

interface CaseEvaluation {
	caseId: string;
	title: string;
	score: number;
	summary: string;
	strengths: string[];
	weaknesses: string[];
}

interface PromptEvaluation {
	score: number;
	keep: boolean;
	decision: "keep" | "discard";
	summary: string;
	strengths: string[];
	weaknesses: string[];
	suggestions: string[];
	caseEvaluations: CaseEvaluation[];
}

interface ComparatorCaseDecision {
	caseId: string;
	title: string;
	winner: "A" | "B" | "tie";
	reason: string;
}

interface ComparatorResult {
	winner: "A" | "B" | "tie";
	keepCandidate: boolean;
	summary: string;
	reasons: string[];
	caseDecisions: ComparatorCaseDecision[];
}

interface AttemptRecord {
	iteration: number;
	candidatePrompt: string;
	evaluation: PromptEvaluation;
	comparison: ComparatorResult;
	accepted: boolean;
	changeSummary: string;
	hypothesis: string;
}

interface PromptOutput {
	caseId: string;
	title: string;
	output: string;
}

interface PromptRun {
	prompt: string;
	outputs: PromptOutput[];
	evaluation: PromptEvaluation;
}

interface BenchmarkRun {
	runIndex: number;
	score: number;
	summary: string;
}

interface BenchmarkSummary {
	goal: string;
	prompt: string;
	evalCases: EvalCase[];
	runs: BenchmarkRun[];
	meanScore: number;
	minScore: number;
	maxScore: number;
	variance: number;
	stddev: number;
}

interface RunSummary {
	goal: string;
	iterations: number;
	evalCases: EvalCase[];
	baseline: PromptRun;
	best: PromptRun;
	attempts: AttemptRecord[];
}

interface RunToolDetails extends RunSummary {
	acceptedCount: number;
	discardedCount: number;
}

function clampIterations(value: number): number {
	return Math.max(1, Math.min(MAX_ITERATIONS, Math.floor(value)));
}

function clampEvalCaseCount(value: number): number {
	return Math.max(3, Math.min(MAX_EVAL_CASES, Math.floor(value)));
}

function clampBenchmarkRuns(value: number): number {
	return Math.max(1, Math.min(MAX_BENCHMARK_RUNS, Math.floor(value)));
}

function shorten(text: string, maxLength = RESULT_PREVIEW_LIMIT): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n\n[truncated ${text.length - maxLength} chars]`;
}

function trimJsonFence(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	return text.trim();
}

function extractJsonObject(text: string): any {
	const cleaned = trimJsonFence(text);
	try {
		return JSON.parse(cleaned);
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
		throw new Error(`Could not parse JSON from model output:\n${shorten(cleaned, 500)}`);
	}
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item));
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
	if (values.length === 0) return 0;
	const avg = mean(values);
	return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function normalizeCaseEvaluation(value: any, fallbackId: string, fallbackTitle: string): CaseEvaluation {
	const scoreNumber = Number(value?.score);
	return {
		caseId: String(value?.caseId ?? fallbackId),
		title: String(value?.title ?? fallbackTitle),
		score: Number.isFinite(scoreNumber) ? Math.max(0, Math.min(100, scoreNumber)) : 0,
		summary: String(value?.summary ?? "No summary provided."),
		strengths: asStringArray(value?.strengths),
		weaknesses: asStringArray(value?.weaknesses),
	};
}

function normalizePromptEvaluation(value: any, cases: EvalCase[]): PromptEvaluation {
	const scoreNumber = Number(value?.score);
	const keep = Boolean(value?.keep);
	const caseValues = Array.isArray(value?.caseEvaluations) ? value.caseEvaluations : [];
	const caseEvaluations = cases.map((evalCase, index) =>
		normalizeCaseEvaluation(caseValues[index], evalCase.id, evalCase.title),
	);
	return {
		score: Number.isFinite(scoreNumber) ? Math.max(0, Math.min(100, scoreNumber)) : 0,
		keep,
		decision: keep ? "keep" : "discard",
		summary: String(value?.summary ?? "No summary provided."),
		strengths: asStringArray(value?.strengths),
		weaknesses: asStringArray(value?.weaknesses),
		suggestions: asStringArray(value?.suggestions),
		caseEvaluations,
	};
}

function normalizeComparatorResult(value: any, cases: EvalCase[]): ComparatorResult {
	const rawCaseDecisions = Array.isArray(value?.caseDecisions) ? value.caseDecisions : [];
	const caseDecisions = cases.map((evalCase, index) => {
		const raw = rawCaseDecisions[index] ?? {};
		const winner = raw?.winner === "A" || raw?.winner === "B" || raw?.winner === "tie" ? raw.winner : "tie";
		return {
			caseId: String(raw?.caseId ?? evalCase.id),
			title: String(raw?.title ?? evalCase.title),
			winner,
			reason: String(raw?.reason ?? "No reason provided."),
		};
	});
	const winner = value?.winner === "A" || value?.winner === "B" || value?.winner === "tie" ? value.winner : "tie";
	return {
		winner,
		keepCandidate: winner === "B",
		summary: String(value?.summary ?? "No summary provided."),
		reasons: asStringArray(value?.reasons),
		caseDecisions,
	};
}

function normalizeGenerator(value: any): GeneratorResult {
	const candidatePrompt = String(value?.candidatePrompt ?? "").trim();
	if (!candidatePrompt) throw new Error("Generator returned an empty candidatePrompt.");
	return {
		candidatePrompt,
		changeSummary: String(value?.changeSummary ?? "No change summary provided."),
		hypothesis: String(value?.hypothesis ?? "No hypothesis provided."),
	};
}

function normalizeEvalCases(value: any): EvalCase[] {
	const rawCases = Array.isArray(value?.cases) ? value.cases : [];
	const cases = rawCases
		.map((item: any, index: number) => ({
			id: String(item?.id ?? `case-${index + 1}`),
			title: String(item?.title ?? `Case ${index + 1}`),
			input: String(item?.input ?? "").trim(),
			expectedCharacteristics: asStringArray(item?.expectedCharacteristics),
		}))
		.filter((item: EvalCase) => item.input.length > 0);
	if (cases.length === 0) throw new Error("No valid eval cases were generated.");
	return cases;
}

async function writeTempPromptFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-autoresearch-${prefix}-`));
	const filePath = path.join(dir, `${prefix}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function runPiPrompt(
	ctx: ExtensionContext,
	prompt: string,
	systemPrompt?: string,
	signal?: AbortSignal,
): Promise<string> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	];
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (model) args.push("--model", model);

	let tempDir: string | null = null;
	let tempFile: string | null = null;
	if (systemPrompt?.trim()) {
		const temp = await writeTempPromptFile("system", systemPrompt);
		tempDir = temp.dir;
		tempFile = temp.filePath;
		args.push("--append-system-prompt", tempFile);
	}
	args.push(prompt);

	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuffer = "";
			let stderrBuffer = "";
			let finalAssistantText = "";
			let wasAborted = false;

			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const parts = Array.isArray(event.message.content) ? event.message.content : [];
					const text = parts
						.filter((part: any) => part?.type === "text")
						.map((part: any) => String(part.text ?? ""))
						.join("\n")
						.trim();
					if (text) finalAssistantText = text;
				}
			};

			proc.stdout.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderrBuffer += data.toString();
			});

			proc.on("error", (error) => reject(error));
			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
				if (wasAborted) return reject(new Error("Autoresearch run was aborted."));
				if (code !== 0) {
					return reject(new Error(`pi exited with code ${code}: ${shorten(stderrBuffer || "(no stderr)", 500)}`));
				}
				resolve(finalAssistantText.trim());
			});

			if (signal) {
				const abort = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	} finally {
		if (tempFile) try { await fs.promises.unlink(tempFile); } catch {}
		if (tempDir) try { await fs.promises.rmdir(tempDir); } catch {}
	}
}

function buildHistorySummary(attempts: AttemptRecord[]): string {
	if (attempts.length === 0) return "No prior iterations yet.";
	return attempts
		.slice(-HISTORY_PREVIEW_LIMIT)
		.map((attempt) => [
			`Iteration ${attempt.iteration}: ${attempt.accepted ? "accepted" : "discarded"}`,
			`Score: ${attempt.evaluation.score.toFixed(1)}`,
			`Comparison winner: ${attempt.comparison.winner}`,
			`Change: ${attempt.changeSummary}`,
			`Hypothesis: ${attempt.hypothesis}`,
			`Evaluation: ${attempt.evaluation.summary}`,
		].join("\n"))
		.join("\n\n");
}

async function generateEvalCases(
	ctx: ExtensionContext,
	goal: string,
	count: number,
	signal?: AbortSignal,
): Promise<EvalCase[]> {
	const systemPrompt = [
		"You are designing an evaluation suite for prompt optimization.",
		"Return ONLY valid JSON with this shape:",
		'{"cases":[{"id":"case-1","title":"string","input":"string","expectedCharacteristics":["..."]}]}',
		"Create diverse, realistic test cases that stress different aspects of the goal.",
		"Do not wrap the JSON in markdown fences.",
	].join("\n");
	const prompt = [
		`Goal:\n${goal}`,
		"",
		`Create ${count} eval cases for this prompt-improvement task.`,
		"Each case should include concrete input and 2-5 expected characteristics for judging output quality.",
	].join("\n");
	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizeEvalCases(extractJsonObject(raw)).slice(0, count);
}

function buildExecutionPrompt(promptUnderTest: string, evalCase: EvalCase): string {
	return [
		"You are being evaluated.",
		"Apply the PROMPT UNDER TEST to the TEST INPUT and produce the response that prompt would ideally elicit.",
		"Do not discuss the evaluation itself.",
		"",
		"PROMPT UNDER TEST:",
		promptUnderTest,
		"",
		`TEST CASE: ${evalCase.title}`,
		"TEST INPUT:",
		evalCase.input,
	].join("\n");
}

async function runPromptOnEvalCases(
	ctx: ExtensionContext,
	promptUnderTest: string,
	evalCases: EvalCase[],
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<PromptOutput[]> {
	const outputs: PromptOutput[] = [];
	for (let i = 0; i < evalCases.length; i++) {
		const evalCase = evalCases[i];
		onProgress?.(`Running eval case ${i + 1}/${evalCases.length}: ${evalCase.title}`);
		const output = await runPiPrompt(ctx, buildExecutionPrompt(promptUnderTest, evalCase), undefined, signal);
		outputs.push({ caseId: evalCase.id, title: evalCase.title, output });
	}
	return outputs;
}

async function evaluatePromptRun(
	ctx: ExtensionContext,
	goal: string,
	promptUnderTest: string,
	evalCases: EvalCase[],
	outputs: PromptOutput[],
	incumbentScore?: number,
	signal?: AbortSignal,
): Promise<PromptEvaluation> {
	const systemPrompt = [
		"You are a strict evaluator for prompt optimization.",
		"Judge the prompt using the ACTUAL outputs across the full eval suite.",
		"Return ONLY valid JSON with this shape:",
		'{"score":0-100,"keep":true|false,"summary":"string","strengths":["..."],"weaknesses":["..."],"suggestions":["..."],"caseEvaluations":[{"caseId":"string","title":"string","score":0-100,"summary":"string","strengths":["..."],"weaknesses":["..."]}]}',
		"Set keep=true only if this prompt should replace the incumbent when compared to the current best.",
		"Do not wrap the JSON in markdown fences.",
	].join("\n");
	const prompt = [
		`Goal:\n${goal}`,
		"",
		"Prompt under evaluation:",
		promptUnderTest,
		"",
		incumbentScore !== undefined ? `Current best score to beat: ${incumbentScore.toFixed(1)}` : "This is the baseline run.",
		"",
		"Eval cases and outputs:",
		...evalCases.flatMap((evalCase) => {
			const output = outputs.find((item) => item.caseId === evalCase.id)?.output ?? "";
			return [
				`CASE ${evalCase.id}: ${evalCase.title}`,
				"Input:",
				evalCase.input,
				"Expected characteristics:",
				evalCase.expectedCharacteristics.map((item) => `- ${item}`).join("\n"),
				"Actual output:",
				shorten(output, 1500),
				"",
			];
		}),
		"Score the prompt on aggregate quality across the whole suite, not just one case.",
	].join("\n");
	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizePromptEvaluation(extractJsonObject(raw), evalCases);
}

async function comparePromptRuns(
	ctx: ExtensionContext,
	goal: string,
	evalCases: EvalCase[],
	incumbent: PromptRun,
	candidate: PromptRun,
	signal?: AbortSignal,
): Promise<ComparatorResult> {
	const systemPrompt = [
		"You are a blind A/B comparator for prompt optimization.",
		"Version A is the incumbent. Version B is the candidate.",
		"Judge outputs case-by-case without bias toward incumbents or novelty.",
		"Return ONLY valid JSON with this shape:",
		'{"winner":"A"|"B"|"tie","summary":"string","reasons":["..."],"caseDecisions":[{"caseId":"string","title":"string","winner":"A"|"B"|"tie","reason":"string"}]}',
		"Choose B only if it is clearly better overall.",
		"Do not wrap the JSON in markdown fences.",
	].join("\n");
	const prompt = [
		`Goal:\n${goal}`,
		"",
		"Compare Version A and Version B across the eval suite.",
		"Use expected characteristics and actual outputs. Do not prefer longer answers unless they are better.",
		"",
		...evalCases.flatMap((evalCase) => {
			const outputA = incumbent.outputs.find((item) => item.caseId === evalCase.id)?.output ?? "";
			const outputB = candidate.outputs.find((item) => item.caseId === evalCase.id)?.output ?? "";
			return [
				`CASE ${evalCase.id}: ${evalCase.title}`,
				"Input:",
				evalCase.input,
				"Expected characteristics:",
				evalCase.expectedCharacteristics.map((item) => `- ${item}`).join("\n"),
				"Version A output:",
				shorten(outputA, 1200),
				"Version B output:",
				shorten(outputB, 1200),
				"",
			];
		}),
	].join("\n");
	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizeComparatorResult(extractJsonObject(raw), evalCases);
}

async function runAndEvaluatePrompt(
	ctx: ExtensionContext,
	goal: string,
	promptUnderTest: string,
	evalCases: EvalCase[],
	incumbentScore: number | undefined,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<PromptRun> {
	const outputs = await runPromptOnEvalCases(ctx, promptUnderTest, evalCases, onProgress, signal);
	const evaluation = await evaluatePromptRun(ctx, goal, promptUnderTest, evalCases, outputs, incumbentScore, signal);
	return { prompt: promptUnderTest, outputs, evaluation };
}

async function benchmarkPrompt(
	ctx: ExtensionContext,
	goal: string,
	promptUnderTest: string,
	evalCases: EvalCase[],
	runs: number,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<BenchmarkSummary> {
	const benchmarkRuns: BenchmarkRun[] = [];
	for (let runIndex = 1; runIndex <= runs; runIndex++) {
		onProgress?.(`Benchmark run ${runIndex}/${runs}...`);
		const run = await runAndEvaluatePrompt(
			ctx,
			goal,
			promptUnderTest,
			evalCases,
			undefined,
			(message) => onProgress?.(`Benchmark run ${runIndex}/${runs}: ${message}`),
			signal,
		);
		benchmarkRuns.push({ runIndex, score: run.evaluation.score, summary: run.evaluation.summary });
	}
	const scores = benchmarkRuns.map((run) => run.score);
	const varianceValue = variance(scores);
	return {
		goal,
		prompt: promptUnderTest,
		evalCases,
		runs: benchmarkRuns,
		meanScore: mean(scores),
		minScore: scores.length ? Math.min(...scores) : 0,
		maxScore: scores.length ? Math.max(...scores) : 0,
		variance: varianceValue,
		stddev: Math.sqrt(varianceValue),
	};
}

async function generateCandidate(
	ctx: ExtensionContext,
	goal: string,
	bestPrompt: string,
	bestEvaluation: PromptEvaluation,
	evalCases: EvalCase[],
	attempts: AttemptRecord[],
	signal?: AbortSignal,
): Promise<GeneratorResult> {
	const systemPrompt = [
		"You are an expert prompt optimizer.",
		"Produce ONE improved prompt candidate for the user's goal.",
		"Use eval-suite weaknesses and A/B comparison history to address specific failures.",
		"Return ONLY valid JSON with this shape:",
		'{"candidatePrompt":"string","changeSummary":"string","hypothesis":"string"}',
		"Do not wrap the JSON in markdown fences.",
	].join("\n");
	const prompt = [
		`Goal:\n${goal}`,
		"",
		`Current best score: ${bestEvaluation.score.toFixed(1)}`,
		"",
		"Current best prompt:",
		bestPrompt,
		"",
		"Eval suite summary:",
		...evalCases.map((evalCase) => {
			const caseEval = bestEvaluation.caseEvaluations.find((item) => item.caseId === evalCase.id);
			return [
				`${evalCase.id}: ${evalCase.title}`,
				`Expected: ${evalCase.expectedCharacteristics.join("; ")}`,
				`Current score: ${caseEval?.score.toFixed(1) ?? "0.0"}`,
				`Weaknesses: ${(caseEval?.weaknesses ?? []).join("; ") || "none listed"}`,
			].join("\n");
		}),
		"",
		"Recent iteration history:",
		buildHistorySummary(attempts),
		"",
		"Produce a stronger prompt candidate that improves robustness across the full eval suite, not just one example.",
	].join("\n");
	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizeGenerator(extractJsonObject(raw));
}

function buildRunSummaryMessage(summary: RunSummary): string {
	const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
	const discarded = summary.attempts.length - accepted;
	const lines: string[] = [];
	lines.push("# Prompt autoresearch result");
	lines.push("");
	lines.push(`Goal: ${summary.goal}`);
	lines.push(`Iterations: ${summary.iterations}`);
	lines.push(`Eval cases: ${summary.evalCases.length}`);
	lines.push(`Baseline score: ${summary.baseline.evaluation.score.toFixed(1)}`);
	lines.push(`Best score: ${summary.best.evaluation.score.toFixed(1)}`);
	lines.push(`Accepted: ${accepted}`);
	lines.push(`Discarded: ${discarded}`);
	lines.push("");
	lines.push("## Eval suite");
	for (const evalCase of summary.evalCases) {
		const caseEval = summary.best.evaluation.caseEvaluations.find((item) => item.caseId === evalCase.id);
		lines.push(`- ${evalCase.title}: ${caseEval?.score.toFixed(1) ?? "0.0"}`);
	}
	lines.push("");
	lines.push("## Best prompt");
	lines.push(summary.best.prompt);
	lines.push("");
	lines.push("## Iteration log");
	for (const attempt of summary.attempts) {
		lines.push(
			`- Iteration ${attempt.iteration}: ${attempt.accepted ? "kept" : "discarded"} | score ${attempt.evaluation.score.toFixed(1)} | compare ${attempt.comparison.winner} | ${attempt.evaluation.summary}`,
		);
	}
	return lines.join("\n");
}

function buildBenchmarkSummaryMessage(summary: BenchmarkSummary): string {
	const lines: string[] = [];
	lines.push("# Prompt benchmark result");
	lines.push("");
	lines.push(`Goal: ${summary.goal}`);
	lines.push(`Runs: ${summary.runs.length}`);
	lines.push(`Eval cases: ${summary.evalCases.length}`);
	lines.push(`Mean score: ${summary.meanScore.toFixed(1)}`);
	lines.push(`Min score: ${summary.minScore.toFixed(1)}`);
	lines.push(`Max score: ${summary.maxScore.toFixed(1)}`);
	lines.push(`Variance: ${summary.variance.toFixed(2)}`);
	lines.push(`Stddev: ${summary.stddev.toFixed(2)}`);
	lines.push("");
	lines.push("## Prompt");
	lines.push(summary.prompt);
	lines.push("");
	lines.push("## Runs");
	for (const run of summary.runs) {
		lines.push(`- Run ${run.runIndex}: ${run.score.toFixed(1)} | ${run.summary}`);
	}
	return lines.join("\n");
}

async function runAutoresearch(
	ctx: ExtensionContext,
	goal: string,
	iterations: number,
	evalCaseCount: number,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<RunSummary> {
	const baselinePrompt = goal.trim();
	if (!baselinePrompt) throw new Error("Goal cannot be empty.");

	const evalCases = await generateEvalCases(ctx, goal, evalCaseCount, signal);
	const baseline = await runAndEvaluatePrompt(ctx, goal, baselinePrompt, evalCases, undefined, onProgress, signal);
	baseline.evaluation.keep = true;
	baseline.evaluation.decision = "keep";

	let best = baseline;
	const attempts: AttemptRecord[] = [];

	for (let iteration = 1; iteration <= iterations; iteration++) {
		onProgress?.(`Iteration ${iteration}/${iterations}: generating candidate...`);
		const candidate = await generateCandidate(ctx, goal, best.prompt, best.evaluation, evalCases, attempts, signal);

		onProgress?.(`Iteration ${iteration}/${iterations}: running eval suite...`);
		const candidateRun = await runAndEvaluatePrompt(
			ctx,
			goal,
			candidate.candidatePrompt,
			evalCases,
			best.evaluation.score,
			onProgress,
			signal,
		);

		onProgress?.(`Iteration ${iteration}/${iterations}: blind A/B compare...`);
		const comparison = await comparePromptRuns(ctx, goal, evalCases, best, candidateRun, signal);
		const accepted = candidateRun.evaluation.keep && candidateRun.evaluation.score > best.evaluation.score && comparison.keepCandidate;

		attempts.push({
			iteration,
			candidatePrompt: candidate.candidatePrompt,
			evaluation: candidateRun.evaluation,
			comparison,
			accepted,
			changeSummary: candidate.changeSummary,
			hypothesis: candidate.hypothesis,
		});

		if (accepted) {
			best = candidateRun;
			onProgress?.(`Iteration ${iteration}/${iterations}: kept candidate (${best.evaluation.score.toFixed(1)}; compare ${comparison.winner}).`);
		} else {
			onProgress?.(`Iteration ${iteration}/${iterations}: discarded candidate (${candidateRun.evaluation.score.toFixed(1)}; compare ${comparison.winner}).`);
		}
	}

	return { goal, iterations, evalCases, baseline, best, attempts };
}

function parseAutoresearchArgs(rawArgs: string, defaultIterations: number): { goal: string; iterations: number } {
	const match = rawArgs.match(/^\s*--iterations\s+(\d+)\s+([\s\S]+)$/i);
	if (match) return { iterations: clampIterations(Number(match[1])), goal: match[2].trim() };
	return { goal: rawArgs.trim(), iterations: defaultIterations };
}

function parseBenchmarkArgs(rawArgs: string): { goal: string; runs: number } {
	const match = rawArgs.match(/^\s*--runs\s+(\d+)\s+([\s\S]+)$/i);
	if (match) return { runs: clampBenchmarkRuns(Number(match[1])), goal: match[2].trim() };
	return { goal: rawArgs.trim(), runs: DEFAULT_BENCHMARK_RUNS };
}

export default function promptAutoresearchExtension(pi: ExtensionAPI) {
	let defaultIterations = DEFAULT_ITERATIONS;

	const restoreConfig = (ctx: ExtensionContext) => {
		defaultIterations = DEFAULT_ITERATIONS;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "prompt-autoresearch-config") continue;
			const value = Number((entry.data as any)?.defaultIterations);
			if (Number.isFinite(value)) defaultIterations = clampIterations(value);
		}
	};

	pi.on("session_start", async (_event, ctx) => restoreConfig(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreConfig(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreConfig(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreConfig(ctx));

	pi.registerCommand("autoresearch", {
		description: "Run prompt autoresearch with eval-suite scoring and blind A/B comparison. Usage: /autoresearch [--iterations N] <goal>",
		handler: async (args, ctx) => {
			const parsed = parseAutoresearchArgs(args, defaultIterations);
			if (!parsed.goal) {
				ctx.ui.notify("Usage: /autoresearch [--iterations N] <goal>", "warning");
				return;
			}
			ctx.ui.setStatus("prompt-autoresearch", `Running autoresearch (${parsed.iterations} iterations)...`);
			try {
				const summary = await runAutoresearch(ctx, parsed.goal, parsed.iterations, DEFAULT_EVAL_CASES, (message) => {
					ctx.ui.setStatus("prompt-autoresearch", message);
				});
				const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
				const discarded = summary.attempts.length - accepted;
				const details: RunToolDetails = { ...summary, acceptedCount: accepted, discardedCount: discarded };
				pi.sendMessage({
					customType: "prompt-autoresearch-result",
					content: buildRunSummaryMessage(summary),
					display: true,
					details,
				});
				ctx.ui.notify(`Autoresearch finished. Best score: ${summary.best.evaluation.score.toFixed(1)}`, "success");
				if (ctx.hasUI) ctx.ui.setEditorText(summary.best.prompt);
			} catch (error) {
				ctx.ui.notify(`Autoresearch failed: ${(error as Error).message}`, "error");
			} finally {
				ctx.ui.setStatus("prompt-autoresearch", "");
			}
		},
	});

	pi.registerCommand("autoresearch-benchmark", {
		description: "Benchmark a prompt across repeated eval-suite runs. Usage: /autoresearch-benchmark [--runs N] <goal>",
		handler: async (args, ctx) => {
			const parsed = parseBenchmarkArgs(args);
			if (!parsed.goal) {
				ctx.ui.notify("Usage: /autoresearch-benchmark [--runs N] <goal>", "warning");
				return;
			}
			ctx.ui.setStatus("prompt-autoresearch", `Running benchmark (${parsed.runs} runs)...`);
			try {
				const evalCases = await generateEvalCases(ctx, parsed.goal, DEFAULT_EVAL_CASES);
				const benchmark = await benchmarkPrompt(
					ctx,
					parsed.goal,
					parsed.goal.trim(),
					evalCases,
					parsed.runs,
					(message) => ctx.ui.setStatus("prompt-autoresearch", message),
				);
				pi.sendMessage({
					customType: "prompt-autoresearch-benchmark",
					content: buildBenchmarkSummaryMessage(benchmark),
					display: true,
					details: benchmark,
				});
				ctx.ui.notify(`Benchmark finished. Mean score: ${benchmark.meanScore.toFixed(1)}`, "success");
			} catch (error) {
				ctx.ui.notify(`Benchmark failed: ${(error as Error).message}`, "error");
			} finally {
				ctx.ui.setStatus("prompt-autoresearch", "");
			}
		},
	});

	pi.registerCommand("autoresearch-iterations", {
		description: "Set the default autoresearch iteration count (default 10, max 100)",
		handler: async (args, ctx) => {
			const value = Number(args.trim());
			if (!Number.isFinite(value) || value < 1) {
				ctx.ui.notify("Usage: /autoresearch-iterations <positive number>", "warning");
				return;
			}
			defaultIterations = clampIterations(value);
			pi.appendEntry("prompt-autoresearch-config", { defaultIterations });
			ctx.ui.notify(`Autoresearch iterations set to ${defaultIterations}`, "success");
		},
	});

	pi.registerTool({
		name: "run_prompt_autoresearch",
		label: "Prompt Autoresearch",
		description: "Run prompt improvement with eval-suite execution, scoring, blind A/B comparison, and keep/discard decisions.",
		promptSnippet: "Improve a prompt over multiple evaluated iterations and return the best prompt found",
		promptGuidelines: ["Use this tool when the user asks for automatic prompt optimization or iterative prompt improvement."],
		parameters: Type.Object({
			goal: Type.String({ description: "The task or outcome the optimized prompt should achieve" }),
			iterations: Type.Optional(Type.Number({ description: "Iteration count. Default is 10 unless the user configured a higher default." })),
			evalCases: Type.Optional(Type.Number({ description: "How many eval cases to generate. Default 5, max 8." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const iterations = clampIterations(params.iterations ?? defaultIterations);
			const evalCaseCount = clampEvalCaseCount(params.evalCases ?? DEFAULT_EVAL_CASES);
			onUpdate?.({ content: [{ type: "text", text: `Running autoresearch (${iterations} iterations)...` }] });
			const summary = await runAutoresearch(ctx, params.goal, iterations, evalCaseCount, (message) => {
				onUpdate?.({ content: [{ type: "text", text: message }] });
			}, signal);
			const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
			const discarded = summary.attempts.length - accepted;
			const details: RunToolDetails = { ...summary, acceptedCount: accepted, discardedCount: discarded };
			return {
				content: [{ type: "text", text: buildRunSummaryMessage(summary) }],
				details,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("prompt-autoresearch ")) +
					theme.fg("accent", `${args.iterations ?? defaultIterations} iterations`) +
					theme.fg("dim", ` ${String(args.goal).slice(0, 70)}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as RunToolDetails | undefined;
			if (!details) {
				const textPart = result.content.find((part) => part.type === "text");
				return new Text(textPart?.type === "text" ? textPart.text : "Autoresearch finished.", 0, 0);
			}
			const lines: string[] = [];
			lines.push(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("prompt autoresearch"))} ${theme.fg("accent", details.best.evaluation.score.toFixed(1))}`);
			lines.push(theme.fg("muted", `goal: ${details.goal}`));
			lines.push(theme.fg("muted", `iterations: ${details.iterations} | eval cases: ${details.evalCases.length} | accepted: ${details.acceptedCount} | discarded: ${details.discardedCount}`));
			lines.push("");
			lines.push(theme.fg("accent", "Best prompt:"));
			lines.push(expanded ? details.best.prompt : shorten(details.best.prompt, 300));
			lines.push("");
			lines.push(theme.fg("accent", "Eval suite:"));
			for (const evalCase of details.evalCases) {
				const caseEval = details.best.evaluation.caseEvaluations.find((item) => item.caseId === evalCase.id);
				lines.push(`- ${evalCase.title}: ${(caseEval?.score ?? 0).toFixed(1)} | ${caseEval?.summary ?? ""}`);
			}
			if (expanded) {
				lines.push("");
				lines.push(theme.fg("accent", "Iteration log:"));
				for (const attempt of details.attempts) {
					lines.push(`- ${attempt.iteration}. ${attempt.accepted ? "kept" : "discarded"} | ${attempt.evaluation.score.toFixed(1)} | compare ${attempt.comparison.winner} | ${attempt.evaluation.summary}`);
				}
			} else if (details.attempts.length > 0) {
				lines.push("");
				lines.push(theme.fg("dim", "Expand to inspect the full iteration log."));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "benchmark_prompt_autoresearch",
		label: "Benchmark Prompt",
		description: "Benchmark a prompt over repeated eval-suite runs and report variance.",
		promptSnippet: "Benchmark a prompt with repeated eval runs and report mean score and variance",
		promptGuidelines: ["Use this tool when the user asks for benchmark runs, stability, variance, or confidence in prompt quality."],
		parameters: Type.Object({
			goal: Type.String({ description: "The prompt or goal to benchmark" }),
			runs: Type.Optional(Type.Number({ description: "How many benchmark repetitions to run. Default 3, max 10." })),
			evalCases: Type.Optional(Type.Number({ description: "How many eval cases to generate. Default 5, max 8." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runs = clampBenchmarkRuns(params.runs ?? DEFAULT_BENCHMARK_RUNS);
			const evalCaseCount = clampEvalCaseCount(params.evalCases ?? DEFAULT_EVAL_CASES);
			onUpdate?.({ content: [{ type: "text", text: `Running benchmark (${runs} runs)...` }] });
			const evalCases = await generateEvalCases(ctx, params.goal, evalCaseCount, signal);
			const benchmark = await benchmarkPrompt(ctx, params.goal, params.goal.trim(), evalCases, runs, (message) => {
				onUpdate?.({ content: [{ type: "text", text: message }] });
			}, signal);
			return {
				content: [{ type: "text", text: buildBenchmarkSummaryMessage(benchmark) }],
				details: benchmark,
			};
		},
	});
}
