import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_ITERATIONS = 10;
const MAX_ITERATIONS = 100;
const RESULT_PREVIEW_LIMIT = 1200;
const HISTORY_PREVIEW_LIMIT = 6;

interface GeneratorResult {
	candidatePrompt: string;
	changeSummary: string;
	hypothesis: string;
}

interface EvaluationResult {
	score: number;
	keep: boolean;
	decision: "keep" | "discard";
	summary: string;
	strengths: string[];
	weaknesses: string[];
	suggestions: string[];
}

interface AttemptRecord {
	iteration: number;
	candidatePrompt: string;
	candidateOutput: string;
	evaluation: EvaluationResult;
	accepted: boolean;
	changeSummary: string;
	hypothesis: string;
}

interface RunSummary {
	goal: string;
	iterations: number;
	baselinePrompt: string;
	baselineOutput: string;
	baselineEvaluation: EvaluationResult;
	bestPrompt: string;
	bestOutput: string;
	bestScore: number;
	attempts: AttemptRecord[];
}

interface RunToolDetails extends RunSummary {
	acceptedCount: number;
	discardedCount: number;
}

function clampIterations(value: number): number {
	return Math.max(1, Math.min(MAX_ITERATIONS, Math.floor(value)));
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
		if (start >= 0 && end > start) {
			return JSON.parse(cleaned.slice(start, end + 1));
		}
		throw new Error(`Could not parse JSON from model output:\n${shorten(cleaned, 500)}`);
	}
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item));
}

function normalizeEvaluation(value: any): EvaluationResult {
	const scoreNumber = Number(value?.score);
	const score = Number.isFinite(scoreNumber) ? Math.max(0, Math.min(100, scoreNumber)) : 0;
	const keep = Boolean(value?.keep);
	const decision: "keep" | "discard" = keep ? "keep" : "discard";
	return {
		score,
		keep,
		decision,
		summary: String(value?.summary ?? "No summary provided."),
		strengths: asStringArray(value?.strengths),
		weaknesses: asStringArray(value?.weaknesses),
		suggestions: asStringArray(value?.suggestions),
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

async function writeTempPromptFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-autoresearch-${prefix}-`));
	const filePath = path.join(dir, `${prefix}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

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
				if (wasAborted) {
					reject(new Error("Autoresearch run was aborted."));
					return;
				}
				if (code !== 0) {
					reject(new Error(`pi exited with code ${code}: ${shorten(stderrBuffer || "(no stderr)", 500)}`));
					return;
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
		if (tempFile) {
			try {
				await fs.promises.unlink(tempFile);
			} catch {
				// ignore cleanup errors
			}
		}
		if (tempDir) {
			try {
				await fs.promises.rmdir(tempDir);
			} catch {
				// ignore cleanup errors
			}
		}
	}
}

function buildHistorySummary(attempts: AttemptRecord[]): string {
	if (attempts.length === 0) return "No prior iterations yet.";
	const recent = attempts.slice(-HISTORY_PREVIEW_LIMIT);
	return recent
		.map((attempt) => {
			return [
				`Iteration ${attempt.iteration}: ${attempt.accepted ? "accepted" : "discarded"}`,
				`Score: ${attempt.evaluation.score.toFixed(1)}`,
				`Change: ${attempt.changeSummary}`,
				`Hypothesis: ${attempt.hypothesis}`,
				`Evaluation: ${attempt.evaluation.summary}`,
			].join("\n");
		})
		.join("\n\n");
}

async function generateCandidate(
	ctx: ExtensionContext,
	goal: string,
	bestPrompt: string,
	bestScore: number,
	attempts: AttemptRecord[],
	signal?: AbortSignal,
): Promise<GeneratorResult> {
	const systemPrompt = [
		"You are an expert prompt optimizer.",
		"Your job is to produce ONE improved prompt candidate for the user's goal.",
		"You must improve the prompt based on previous evaluation feedback.",
		"Return ONLY valid JSON with this shape:",
		'{"candidatePrompt":"string","changeSummary":"string","hypothesis":"string"}',
		"Do not wrap the JSON in markdown fences.",
	].join("\n");

	const prompt = [
		`Goal:\n${goal}`,
		"",
		`Current best score: ${bestScore.toFixed(1)}`,
		"",
		"Current best prompt:",
		bestPrompt,
		"",
		"Recent iteration history:",
		buildHistorySummary(attempts),
		"",
		"Produce a stronger prompt candidate. Prefer concrete structure, explicit success criteria, and output formatting requirements when helpful.",
	].join("\n");

	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizeGenerator(extractJsonObject(raw));
}

async function evaluateCandidate(
	ctx: ExtensionContext,
	goal: string,
	candidatePrompt: string,
	candidateOutput: string,
	incumbentPrompt: string,
	incumbentOutput: string,
	incumbentScore: number,
	signal?: AbortSignal,
): Promise<EvaluationResult> {
	const systemPrompt = [
		"You are a strict evaluator for prompt optimization.",
		"Judge the candidate using the ACTUAL output it produced.",
		"Recommend keep=true only if the candidate is genuinely better than the incumbent.",
		"Use the rubric: objective fit, specificity, completeness, structure, and result quality.",
		"Return ONLY valid JSON with this shape:",
		'{"score":0-100,"keep":true|false,"summary":"string","strengths":["..."],"weaknesses":["..."],"suggestions":["..."]}',
		"Do not wrap the JSON in markdown fences.",
	].join("\n");

	const prompt = [
		`Goal:\n${goal}`,
		"",
		"Incumbent prompt:",
		incumbentPrompt,
		"",
		"Incumbent output:",
		shorten(incumbentOutput, 2000),
		"",
		`Incumbent score: ${incumbentScore.toFixed(1)}`,
		"",
		"Candidate prompt:",
		candidatePrompt,
		"",
		"Candidate output:",
		shorten(candidateOutput, 2000),
		"",
		"Be skeptical. If the candidate is not clearly better, set keep to false.",
	].join("\n");

	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	return normalizeEvaluation(extractJsonObject(raw));
}

async function evaluateBaseline(
	ctx: ExtensionContext,
	goal: string,
	baselinePrompt: string,
	baselineOutput: string,
	signal?: AbortSignal,
): Promise<EvaluationResult> {
	const systemPrompt = [
		"You are a strict evaluator for a baseline prompt.",
		"Score how well the prompt output meets the goal.",
		"Return ONLY valid JSON with this shape:",
		'{"score":0-100,"keep":true,"summary":"string","strengths":["..."],"weaknesses":["..."],"suggestions":["..."]}',
		"Set keep to true for the baseline. Do not wrap the JSON in markdown fences.",
	].join("\n");

	const prompt = [
		`Goal:\n${goal}`,
		"",
		"Baseline prompt:",
		baselinePrompt,
		"",
		"Baseline output:",
		shorten(baselineOutput, 2000),
		"",
		"Score this baseline on the same 0-100 scale used for later comparisons.",
	].join("\n");

	const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
	const evaluation = normalizeEvaluation(extractJsonObject(raw));
	evaluation.keep = true;
	evaluation.decision = "keep";
	return evaluation;
}

function buildRunSummaryMessage(summary: RunSummary): string {
	const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
	const discarded = summary.attempts.length - accepted;
	const lines: string[] = [];
	lines.push(`# Prompt autoresearch result`);
	lines.push("");
	lines.push(`Goal: ${summary.goal}`);
	lines.push(`Iterations: ${summary.iterations}`);
	lines.push(`Baseline score: ${summary.baselineEvaluation.score.toFixed(1)}`);
	lines.push(`Best score: ${summary.bestScore.toFixed(1)}`);
	lines.push(`Accepted: ${accepted}`);
	lines.push(`Discarded: ${discarded}`);
	lines.push("");
	lines.push("## Best prompt");
	lines.push(summary.bestPrompt);
	lines.push("");
	lines.push("## Best output preview");
	lines.push(shorten(summary.bestOutput, 1200));
	lines.push("");
	lines.push("## Iteration log");
	for (const attempt of summary.attempts) {
		lines.push(
			`- Iteration ${attempt.iteration}: ${attempt.accepted ? "kept" : "discarded"} | score ${attempt.evaluation.score.toFixed(1)} | ${attempt.evaluation.summary}`,
		);
	}
	return lines.join("\n");
}

async function runAutoresearch(
	ctx: ExtensionContext,
	goal: string,
	iterations: number,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<RunSummary> {
	const baselinePrompt = goal.trim();
	if (!baselinePrompt) throw new Error("Goal cannot be empty.");

	onProgress?.("Running baseline prompt...");
	const baselineOutput = await runPiPrompt(ctx, baselinePrompt, undefined, signal);
	const baselineEvaluation = await evaluateBaseline(ctx, goal, baselinePrompt, baselineOutput, signal);

	let bestPrompt = baselinePrompt;
	let bestOutput = baselineOutput;
	let bestScore = baselineEvaluation.score;
	const attempts: AttemptRecord[] = [];

	for (let iteration = 1; iteration <= iterations; iteration++) {
		onProgress?.(`Iteration ${iteration}/${iterations}: generating candidate...`);
		const candidate = await generateCandidate(ctx, goal, bestPrompt, bestScore, attempts, signal);

		onProgress?.(`Iteration ${iteration}/${iterations}: executing candidate prompt...`);
		const candidateOutput = await runPiPrompt(ctx, candidate.candidatePrompt, undefined, signal);

		onProgress?.(`Iteration ${iteration}/${iterations}: evaluating candidate...`);
		const evaluation = await evaluateCandidate(
			ctx,
			goal,
			candidate.candidatePrompt,
			candidateOutput,
			bestPrompt,
			bestOutput,
			bestScore,
			signal,
		);

		const accepted = evaluation.keep && evaluation.score > bestScore;
		attempts.push({
			iteration,
			candidatePrompt: candidate.candidatePrompt,
			candidateOutput,
			evaluation,
			accepted,
			changeSummary: candidate.changeSummary,
			hypothesis: candidate.hypothesis,
		});

		if (accepted) {
			bestPrompt = candidate.candidatePrompt;
			bestOutput = candidateOutput;
			bestScore = evaluation.score;
			onProgress?.(`Iteration ${iteration}/${iterations}: kept candidate (${bestScore.toFixed(1)}).`);
		} else {
			onProgress?.(`Iteration ${iteration}/${iterations}: discarded candidate (${evaluation.score.toFixed(1)}).`);
		}
	}

	return {
		goal,
		iterations,
		baselinePrompt,
		baselineOutput,
		baselineEvaluation,
		bestPrompt,
		bestOutput,
		bestScore,
		attempts,
	};
}

function parseAutoresearchArgs(rawArgs: string, defaultIterations: number): { goal: string; iterations: number } {
	const match = rawArgs.match(/^\s*--iterations\s+(\d+)\s+([\s\S]+)$/i);
	if (match) {
		return {
			iterations: clampIterations(Number(match[1])),
			goal: match[2].trim(),
		};
	}
	return { goal: rawArgs.trim(), iterations: defaultIterations };
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
		description: "Run prompt autoresearch. Usage: /autoresearch [--iterations N] <goal>",
		handler: async (args, ctx) => {
			const parsed = parseAutoresearchArgs(args, defaultIterations);
			if (!parsed.goal) {
				ctx.ui.notify("Usage: /autoresearch [--iterations N] <goal>", "warning");
				return;
			}

			ctx.ui.setStatus("prompt-autoresearch", `Running autoresearch (${parsed.iterations} iterations)...`);
			try {
				const summary = await runAutoresearch(
					ctx,
					parsed.goal,
					parsed.iterations,
					(message) => ctx.ui.setStatus("prompt-autoresearch", message),
				);
				const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
				const discarded = summary.attempts.length - accepted;
				const details: RunToolDetails = {
					...summary,
					acceptedCount: accepted,
					discardedCount: discarded,
				};
				pi.sendMessage({
					customType: "prompt-autoresearch-result",
					content: buildRunSummaryMessage(summary),
					display: true,
					details,
				});
				ctx.ui.notify(`Autoresearch finished. Best score: ${summary.bestScore.toFixed(1)}`, "success");
				if (ctx.hasUI) ctx.ui.setEditorText(summary.bestPrompt);
			} catch (error) {
				ctx.ui.notify(`Autoresearch failed: ${(error as Error).message}`, "error");
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
		description:
			"Run a fixed-length prompt improvement loop with execution-based evaluation. It generates prompt candidates, runs each candidate, evaluates the produced result, and keeps or discards the iteration.",
		promptSnippet: "Improve a prompt over multiple evaluated iterations and return the best prompt found",
		promptGuidelines: [
			"Use this tool when the user asks for automatic prompt optimization or iterative prompt improvement.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "The task or outcome the optimized prompt should achieve" }),
			iterations: Type.Optional(
				Type.Number({ description: "Iteration count. Default is 10 unless the user configured a higher default." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const iterations = clampIterations(params.iterations ?? defaultIterations);
			onUpdate?.({ content: [{ type: "text", text: `Running autoresearch (${iterations} iterations)...` }] });
			const summary = await runAutoresearch(ctx, params.goal, iterations, (message) => {
				onUpdate?.({ content: [{ type: "text", text: message }] });
			}, signal);
			const accepted = summary.attempts.filter((attempt) => attempt.accepted).length;
			const discarded = summary.attempts.length - accepted;
			const details: RunToolDetails = {
				...summary,
				acceptedCount: accepted,
				discardedCount: discarded,
			};
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
			lines.push(
				`${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("prompt autoresearch"))} ${theme.fg("accent", details.bestScore.toFixed(1))}`,
			);
			lines.push(theme.fg("muted", `goal: ${details.goal}`));
			lines.push(
				theme.fg(
					"muted",
					`iterations: ${details.iterations} | accepted: ${details.acceptedCount} | discarded: ${details.discardedCount}`,
				),
			);
			lines.push("");
			lines.push(theme.fg("accent", "Best prompt:"));
			lines.push(expanded ? details.bestPrompt : shorten(details.bestPrompt, 300));
			if (expanded) {
				lines.push("");
				lines.push(theme.fg("accent", "Iteration log:"));
				for (const attempt of details.attempts) {
					lines.push(
						`- ${attempt.iteration}. ${attempt.accepted ? "kept" : "discarded"} | ${attempt.evaluation.score.toFixed(1)} | ${attempt.evaluation.summary}`,
					);
				}
			} else if (details.attempts.length > 0) {
				lines.push("");
				lines.push(theme.fg("dim", "Expand to inspect the full iteration log."));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
