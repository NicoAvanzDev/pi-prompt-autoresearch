import * as fs from "node:fs";
import * as path from "node:path";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  clampBenchmarkRuns,
  clampEvalCaseCount,
  clampIterations,
  clampProgress,
  computeRelativeImprovement,
  countConsecutiveDiscards,
  earlyExitThreshold,
  formatScore,
  formatSignedPercent,
  makeProgressBar,
  mean,
  parseAutoresearchArgs,
  parseBenchmarkArgs,
  shouldSkipComparison,
  variance,
  summarizeGoal,
  formatDuration,
  estimateRemainingMs,
  statusColor,
} from "./utils.ts";
import {
  applySnapshotPatch,
  completeSnapshot,
  createInitialJobSnapshot,
  enterPaused,
  failSnapshot,
  getStatusText,
  killSnapshot,
  resumeSnapshot,
  requestPause,
  type JobSnapshot,
} from "./job-state.ts";
import { PROMPT_FILE_NAME } from "./prompt-file.ts";
import type {
  ActiveJob,
  AttemptRecord,
  AutoresearchCallbacks,
  BenchmarkRun,
  BenchmarkSummary,
  ComparatorResult,
  EvalCase,
  PromptEvaluation,
  PromptOutput,
  PromptRun,
  RunSummary,
  RunToolDetails,
} from "./types.ts";
import {
  countAttemptResults,
  extractJsonObject,
  normalizeComparatorResult,
  normalizeEvalCases,
  normalizeGenerator,
  normalizePromptEvaluation,
  throwIfAborted,
} from "./normalize.ts";
import {
  buildBenchmarkSummaryMessage,
  buildExecutionPrompt,
  buildHistorySummary,
  buildRunSummaryMessage,
  shorten,
} from "./format.ts";

const DEFAULT_ITERATIONS = 10;
const DEFAULT_EVAL_CASES = 5;
const DEFAULT_BENCHMARK_RUNS = 3;
const PERSISTENT_PHASES: ReadonlySet<string> = new Set([
  "iteration-setup",
  "kept-candidate",
  "discarded-candidate",
  "completed",
]);

async function runPiPrompt(
  ctx: ExtensionContext,
  prompt: string,
  systemPrompt?: string,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model available. Select a model before running autoresearch.");
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) throw new Error(`No API key for ${model.provider}/${model.id}.`);

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const options: Record<string, unknown> = { apiKey, signal };
  if (maxTokens !== undefined) options.maxTokens = maxTokens;

  const resolvedSystemPrompt = systemPrompt?.trim() || "Follow the user instructions.";

  const response = await complete(
    model,
    { systemPrompt: resolvedSystemPrompt, messages: [userMessage] },
    options,
  );

  if (response.stopReason === "aborted") throw new Error("Autoresearch run was aborted.");
  if (response.stopReason === "error")
    throw new Error(response.errorMessage ?? "Model returned an error.");

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Model returned empty response.");
  return text;
}

async function generateGoalSummary(
  ctx: ExtensionContext,
  goal: string,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = [
    "You summarize prompt-optimization goals for a terminal UI.",
    "Return exactly one concise sentence fragment, max 100 characters if possible.",
    "Do not use markdown, bullets, quotes, or labels.",
  ].join("\n");
  const prompt = [`Goal to summarize:`, goal].join("\n");
  try {
    const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal, 256);
    const cleaned = raw
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*"']+|[-*"']+$/g, "");
    return summarizeGoal(cleaned || goal);
  } catch {
    return summarizeGoal(goal);
  }
}

async function generateInitialPrompt(
  ctx: ExtensionContext,
  goal: string,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = [
    "You are an expert prompt engineer.",
    "Given a user goal, create the best possible initial prompt to accomplish that goal.",
    "Return only the prompt text itself.",
    "Do not add commentary, markdown fences, or explanations.",
  ].join("\n");
  const prompt = ["Create an initial prompt for this goal:", goal].join("\n\n");
  const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal);
  const candidate = raw.trim();
  if (!candidate) throw new Error("Initial prompt generation returned empty output.");
  return candidate;
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
  const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal, 4096);
  return normalizeEvalCases(extractJsonObject(raw)).slice(0, count);
}

async function runPromptOnEvalCases(
  ctx: ExtensionContext,
  promptUnderTest: string,
  evalCases: EvalCase[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  onCaseStart?: (evalCase: EvalCase, index: number, total: number) => Promise<void> | void,
  concurrency = 3,
): Promise<PromptOutput[]> {
  const results: PromptOutput[] = Array.from({ length: evalCases.length });
  let completed = 0;

  const runCase = async (i: number) => {
    throwIfAborted(signal);
    const evalCase = evalCases[i];
    await onCaseStart?.(evalCase, i + 1, evalCases.length);
    onProgress?.(`Running eval case ${i + 1}/${evalCases.length}: ${evalCase.title}`);
    const output = await runPiPrompt(
      ctx,
      buildExecutionPrompt(promptUnderTest, evalCase),
      "You are being evaluated. Apply the prompt under test to the provided input faithfully.",
      signal,
    );
    results[i] = { caseId: evalCase.id, title: evalCase.title, output };
    completed++;
    onProgress?.(`Completed ${completed}/${evalCases.length} eval cases`);
  };

  const queue = [...evalCases.keys()];
  const workers = Array.from({ length: Math.min(concurrency, evalCases.length) }, async () => {
    while (queue.length > 0) {
      const idx = queue.shift()!;
      await runCase(idx);
    }
  });
  await Promise.all(workers);
  return results;
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
    incumbentScore !== undefined
      ? `Current best score to beat: ${incumbentScore.toFixed(1)}`
      : "This is the baseline run.",
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
  const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal, 4096);
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
  const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal, 4096);
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
  onCaseStart?: (evalCase: EvalCase, index: number, total: number) => Promise<void> | void,
): Promise<PromptRun> {
  const outputs = await runPromptOnEvalCases(
    ctx,
    promptUnderTest,
    evalCases,
    onProgress,
    signal,
    onCaseStart,
  );
  const evaluation = await evaluatePromptRun(
    ctx,
    goal,
    promptUnderTest,
    evalCases,
    outputs,
    incumbentScore,
    signal,
  );
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
  const raw = await runPiPrompt(ctx, prompt, systemPrompt, signal, 8192);
  return normalizeGenerator(extractJsonObject(raw));
}

async function runAutoresearch(
  ctx: ExtensionContext,
  goal: string,
  iterations: number,
  evalCaseCount: number,
  callbacks?: AutoresearchCallbacks,
  signal?: AbortSignal,
): Promise<RunSummary> {
  if (!goal.trim()) throw new Error("Goal cannot be empty.");

  callbacks?.onProgress?.(`Generating initial prompt...`);
  await callbacks?.beforeStep?.();
  const baselinePrompt = await generateInitialPrompt(ctx, goal, signal);
  await callbacks?.onStateChange?.({
    phase: "initial-prompt",
    bestPrompt: baselinePrompt,
    message: `Generated initial prompt. Designing eval suite...`,
  });

  callbacks?.onProgress?.(`Designing eval suite (${evalCaseCount} cases)...`);
  await callbacks?.beforeStep?.();
  const evalCases = await generateEvalCases(ctx, goal, evalCaseCount, signal);
  await callbacks?.onStateChange?.({
    phase: "baseline",
    totalCases: evalCases.length,
    evalCaseCount: evalCases.length,
    message: `Generated ${evalCases.length} eval cases. Running baseline...`,
  });

  const baseline = await runAndEvaluatePrompt(
    ctx,
    goal,
    baselinePrompt,
    evalCases,
    undefined,
    callbacks?.onProgress,
    signal,
    async (evalCase, index, total) => {
      await callbacks?.beforeStep?.();
      await callbacks?.onStateChange?.({
        phase: "baseline",
        currentCaseIndex: index,
        totalCases: total,
        currentCaseTitle: evalCase.title,
        message: `Baseline: eval case ${index}/${total}`,
      });
    },
  );
  baseline.evaluation.keep = true;
  baseline.evaluation.decision = "keep";

  let best = baseline;
  const attempts: AttemptRecord[] = [];
  await callbacks?.onStateChange?.({
    phase: "iteration-setup",
    baselineScore: baseline.evaluation.score,
    bestScore: baseline.evaluation.score,
    bestPrompt: baseline.prompt,
    currentScore: baseline.evaluation.score,
    currentCandidateVsBaselinePct: 0,
    currentCandidateVsBestPct: 0,
    currentCaseTitle: undefined,
    overallImprovementPct: 0,
    message: `Baseline complete (${baseline.evaluation.score.toFixed(1)}).`,
  });

  for (let iteration = 1; iteration <= iterations; iteration++) {
    throwIfAborted(signal);
    await callbacks?.beforeStep?.();
    await callbacks?.onStateChange?.({
      currentIteration: iteration,
      phase: "generate-candidate",
      currentCaseIndex: 0,
      currentCaseTitle: undefined,
      currentCandidateVsBaselinePct: undefined,
      currentCandidateVsBestPct: undefined,
      message: `Iteration ${iteration}/${iterations}: generating candidate...`,
    });
    callbacks?.onProgress?.(`Iteration ${iteration}/${iterations}: generating candidate...`);
    const candidate = await generateCandidate(
      ctx,
      goal,
      best.prompt,
      best.evaluation,
      evalCases,
      attempts,
      signal,
    );

    await callbacks?.beforeStep?.();
    await callbacks?.onStateChange?.({
      phase: "run-eval-suite",
      message: `Iteration ${iteration}/${iterations}: running eval suite...`,
    });
    callbacks?.onProgress?.(`Iteration ${iteration}/${iterations}: running eval suite...`);
    const candidateRun = await runAndEvaluatePrompt(
      ctx,
      goal,
      candidate.candidatePrompt,
      evalCases,
      best.evaluation.score,
      callbacks?.onProgress,
      signal,
      async (evalCase, index, total) => {
        await callbacks?.beforeStep?.();
        await callbacks?.onStateChange?.({
          currentIteration: iteration,
          phase: "run-eval-suite",
          currentCaseIndex: index,
          totalCases: total,
          currentCaseTitle: evalCase.title,
          message: `Iteration ${iteration}/${iterations}: eval case ${index}/${total}`,
        });
      },
    );
    await callbacks?.onStateChange?.({
      currentIteration: iteration,
      phase: "score-candidate",
      currentScore: candidateRun.evaluation.score,
      currentCandidateVsBaselinePct: computeRelativeImprovement(
        candidateRun.evaluation.score,
        baseline.evaluation.score,
      ),
      currentCandidateVsBestPct: computeRelativeImprovement(
        candidateRun.evaluation.score,
        best.evaluation.score,
      ),
      currentCaseTitle: undefined,
      message: `Iteration ${iteration}/${iterations}: candidate scored ${candidateRun.evaluation.score.toFixed(1)}.`,
    });

    await callbacks?.beforeStep?.();
    await callbacks?.onStateChange?.({
      currentIteration: iteration,
      phase: "compare-a-b",
      currentCaseTitle: undefined,
      message: `Iteration ${iteration}/${iterations}: blind A/B compare...`,
    });
    const previousBestScore = best.evaluation.score;

    let comparison: ComparatorResult;
    if (
      shouldSkipComparison(
        candidateRun.evaluation.score,
        best.evaluation.score,
        candidateRun.evaluation.keep,
      )
    ) {
      callbacks?.onProgress?.(
        `Iteration ${iteration}/${iterations}: skipping A/B (candidate clearly worse).`,
      );
      comparison = {
        winner: "A",
        keepCandidate: false,
        summary: `Skipped: candidate scored ${candidateRun.evaluation.score.toFixed(1)} vs best ${best.evaluation.score.toFixed(1)}`,
        reasons: ["Score gap too large or evaluator recommended discard"],
        caseDecisions: evalCases.map((ec) => ({
          caseId: ec.id,
          title: ec.title,
          winner: "A" as const,
          reason: "Comparison skipped",
        })),
      };
    } else {
      callbacks?.onProgress?.(`Iteration ${iteration}/${iterations}: blind A/B compare...`);
      comparison = await comparePromptRuns(ctx, goal, evalCases, best, candidateRun, signal);
    }
    const accepted =
      candidateRun.evaluation.keep &&
      candidateRun.evaluation.score > best.evaluation.score &&
      comparison.keepCandidate;

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
      callbacks?.onProgress?.(
        `Iteration ${iteration}/${iterations}: kept candidate (${best.evaluation.score.toFixed(1)}; compare ${comparison.winner}).`,
      );
    } else {
      callbacks?.onProgress?.(
        `Iteration ${iteration}/${iterations}: discarded candidate (${candidateRun.evaluation.score.toFixed(1)}; compare ${comparison.winner}).`,
      );
    }
    const { acceptedCount, discardedCount } = countAttemptResults(attempts);
    await callbacks?.onStateChange?.({
      currentIteration: iteration,
      phase: accepted ? "kept-candidate" : "discarded-candidate",
      currentScore: candidateRun.evaluation.score,
      currentCandidateVsBaselinePct: computeRelativeImprovement(
        candidateRun.evaluation.score,
        baseline.evaluation.score,
      ),
      currentCandidateVsBestPct: computeRelativeImprovement(
        candidateRun.evaluation.score,
        previousBestScore,
      ),
      bestScore: best.evaluation.score,
      bestPrompt: best.prompt,
      previousBestScore,
      currentCaseTitle: undefined,
      acceptedCount,
      discardedCount,
      lastAcceptedGainPct: accepted
        ? computeRelativeImprovement(best.evaluation.score, previousBestScore)
        : undefined,
      overallImprovementPct: computeRelativeImprovement(
        best.evaluation.score,
        baseline.evaluation.score,
      ),
      message: accepted
        ? `Iteration ${iteration}/${iterations}: kept candidate (${best.evaluation.score.toFixed(1)}).`
        : `Iteration ${iteration}/${iterations}: discarded candidate (${candidateRun.evaluation.score.toFixed(1)}).`,
    });

    // Early exit when optimization has plateaued
    const consecutiveDiscards = countConsecutiveDiscards(attempts.map((a) => a.accepted));
    const exitThreshold = earlyExitThreshold(iterations);
    if (consecutiveDiscards >= exitThreshold && iteration < iterations) {
      callbacks?.onProgress?.(
        `Early exit after ${consecutiveDiscards} consecutive discards (threshold: ${exitThreshold}).`,
      );
      await callbacks?.onStateChange?.({
        phase: "early-exit",
        message: `Early exit: ${consecutiveDiscards} consecutive discards suggest plateau reached.`,
      });
      break;
    }
  }

  await callbacks?.onStateChange?.({
    phase: "completed",
    currentIteration: iterations,
    currentCaseIndex: evalCases.length,
    totalCases: evalCases.length,
    currentCaseTitle: undefined,
    currentScore: best.evaluation.score,
    currentCandidateVsBaselinePct: computeRelativeImprovement(
      best.evaluation.score,
      baseline.evaluation.score,
    ),
    currentCandidateVsBestPct: 0,
    bestScore: best.evaluation.score,
    bestPrompt: best.prompt,
    overallImprovementPct: computeRelativeImprovement(
      best.evaluation.score,
      baseline.evaluation.score,
    ),
    message: `Completed ${iterations} iterations. Best score ${best.evaluation.score.toFixed(1)}.`,
  });
  return { goal, iterations, evalCases, baseline, best, attempts };
}

export default function promptAutoresearchExtension(pi: ExtensionAPI) {
  let defaultIterations = DEFAULT_ITERATIONS;
  let latestSnapshot: JobSnapshot | null = null;
  let activeJob: ActiveJob | null = null;
  let liveRenderTimer: NodeJS.Timeout | null = null;
  let lastUiContext: ExtensionContext | null = null;

  const buildWidgetLines = (theme: any, snapshot: JobSnapshot, width: number): string[] => {
    const statusCol = statusColor(snapshot.status);
    const overallProgress = clampProgress(
      snapshot.totalIterations > 0
        ? snapshot.currentIteration / Math.max(1, snapshot.totalIterations)
        : 0,
    );
    const caseProgressValue =
      snapshot.totalCases > 0 ? snapshot.currentCaseIndex / Math.max(1, snapshot.totalCases) : 0;
    const caseProgress =
      snapshot.totalCases > 0 ? `${snapshot.currentCaseIndex}/${snapshot.totalCases}` : "—";
    const now =
      snapshot.status === "running" || snapshot.status === "pause-requested"
        ? Date.now()
        : snapshot.updatedAt;
    const elapsedMs = now - snapshot.startedAt;
    const etaMs = estimateRemainingMs(elapsedMs, overallProgress);
    const lines: string[] = [];
    lines.push(theme.fg("accent", theme.bold("Prompt autoresearch")));
    lines.push(
      `${theme.fg("muted", "Goal")}: ${snapshot.goalSummary ?? summarizeGoal(snapshot.goal)}`,
    );
    lines.push(
      `${theme.fg("muted", "Status")}: ${theme.fg(statusCol, snapshot.status)}  ${theme.fg("muted", "Phase")}: ${snapshot.phase || "—"}`,
    );
    lines.push(
      `${theme.fg("muted", "Iteration")}: ${snapshot.currentIteration}/${snapshot.totalIterations}  ${theme.fg("muted", "Case")}: ${caseProgress}`,
    );
    lines.push(
      `${theme.fg("muted", "Elapsed")}: ${formatDuration(elapsedMs)}  ${theme.fg("muted", "ETA")}: ${formatDuration(etaMs)}`,
    );
    lines.push(
      `${theme.fg("muted", "Overall")}: ${theme.fg("accent", makeProgressBar(overallProgress, 24))}`,
    );
    lines.push(
      `${theme.fg("muted", "Case progress")}: ${theme.fg("accent", makeProgressBar(caseProgressValue, 16))}`,
    );
    if (snapshot.currentCaseTitle) {
      lines.push(`${theme.fg("muted", "Current case")}: ${snapshot.currentCaseTitle}`);
    }
    lines.push(
      `${theme.fg("muted", "Baseline")}: ${formatScore(snapshot.baselineScore)}  ${theme.fg("muted", "Current")}: ${formatScore(snapshot.currentScore)}  ${theme.fg("muted", "Best")}: ${formatScore(snapshot.bestScore)}`,
    );
    lines.push(
      `${theme.fg("muted", "Best gain")}: ${theme.fg("success", formatSignedPercent(snapshot.overallImprovementPct))}  ${theme.fg("muted", "Last accepted")}: ${theme.fg("success", formatSignedPercent(snapshot.lastAcceptedGainPct))}`,
    );
    lines.push(
      `${theme.fg("muted", "Current vs baseline")}: ${theme.fg("accent", formatSignedPercent(snapshot.currentCandidateVsBaselinePct))}  ${theme.fg("muted", "Current vs best")}: ${theme.fg("accent", formatSignedPercent(snapshot.currentCandidateVsBestPct))}`,
    );
    lines.push(
      `${theme.fg("muted", "Accepted")}: ${snapshot.acceptedCount}  ${theme.fg("muted", "Discarded")}: ${snapshot.discardedCount}`,
    );
    lines.push(
      theme.fg("dim", `${snapshot.message || "Waiting..."}  ·  file: ${PROMPT_FILE_NAME}`),
    );
    return lines.map((line) => truncateToWidth(line, width));
  };

  const renderSnapshotIntoUi = (ctx: ExtensionContext, snapshot: JobSnapshot | null) => {
    lastUiContext = ctx;
    if (!ctx.hasUI) return;
    if (!snapshot) {
      stopLiveRenderTimer();
      ctx.ui.setStatus("prompt-autoresearch", "");
      ctx.ui.setWidget("prompt-autoresearch-progress", undefined);
      return;
    }
    if (snapshot.status === "running" || snapshot.status === "pause-requested")
      ensureLiveRenderTimer();
    else stopLiveRenderTimer();
    ctx.ui.setStatus("prompt-autoresearch", getStatusText(snapshot));
    ctx.ui.setWidget("prompt-autoresearch-progress", (_tui, theme) => ({
      render: (width: number) => buildWidgetLines(theme, snapshot, width),
      invalidate: () => {},
    }));
  };

  const persistSnapshot = async (ctx: ExtensionContext, snapshot: JobSnapshot) => {
    latestSnapshot = { ...snapshot };
    if (activeJob) activeJob.snapshot = latestSnapshot;
    pi.appendEntry("prompt-autoresearch-job", latestSnapshot);
    if (latestSnapshot.bestPrompt) {
      const promptPath = path.join(ctx.cwd, PROMPT_FILE_NAME);
      await fs.promises.writeFile(promptPath, latestSnapshot.bestPrompt.trim() + "\n", "utf-8");
    }
  };

  const stopLiveRenderTimer = () => {
    if (!liveRenderTimer) return;
    clearInterval(liveRenderTimer);
    liveRenderTimer = null;
  };

  const ensureLiveRenderTimer = () => {
    if (liveRenderTimer) return;
    liveRenderTimer = setInterval(() => {
      if (!latestSnapshot || !lastUiContext) return;
      if (latestSnapshot.status !== "running" && latestSnapshot.status !== "pause-requested")
        return;
      renderSnapshotIntoUi(lastUiContext, latestSnapshot);
    }, 1000);
  };

  const sendLifecycleMessage = (
    snapshot: JobSnapshot,
    kind: string,
    extra?: Record<string, unknown>,
  ) => {
    pi.sendMessage({
      customType: "prompt-autoresearch-update",
      content: snapshot.message,
      display: true,
      details: { ...snapshot, kind, ...extra },
    });
  };

  const shouldPersistPatch = (patch: Partial<JobSnapshot>): boolean => {
    return Boolean(
      patch.status === "paused" ||
      patch.status === "pause-requested" ||
      patch.status === "killed" ||
      patch.status === "failed" ||
      (patch.phase && PERSISTENT_PHASES.has(patch.phase)) ||
      patch.bestPrompt,
    );
  };

  const updateSnapshot = async (
    ctx: ExtensionContext,
    patch: Partial<JobSnapshot>,
    persist = false,
  ) => {
    if (!latestSnapshot) return;
    latestSnapshot = applySnapshotPatch(latestSnapshot, patch);
    if (activeJob) activeJob.snapshot = latestSnapshot;
    renderSnapshotIntoUi(ctx, latestSnapshot);
    if (persist) await persistSnapshot(ctx, latestSnapshot);
  };

  const waitIfPaused = async (ctx: ExtensionContext) => {
    if (!activeJob) return;
    throwIfAborted(activeJob.abortController.signal);
    if (activeJob.pauseRequested && !activeJob.paused) {
      activeJob.paused = true;
      activeJob.pauseRequested = false;
      if (latestSnapshot) {
        latestSnapshot = enterPaused(latestSnapshot);
        if (activeJob) activeJob.snapshot = latestSnapshot;
        renderSnapshotIntoUi(ctx, latestSnapshot);
        await persistSnapshot(ctx, latestSnapshot);
        sendLifecycleMessage(latestSnapshot, "paused");
      }
    }
    while (activeJob.paused) {
      await new Promise<void>((resolve) => activeJob?.resumeResolvers.push(resolve));
      throwIfAborted(activeJob.abortController.signal);
    }
  };

  const restoreConfig = (ctx: ExtensionContext) => {
    defaultIterations = DEFAULT_ITERATIONS;
    latestSnapshot = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "prompt-autoresearch-config") {
        const value = Number((entry.data as any)?.defaultIterations);
        if (Number.isFinite(value)) defaultIterations = clampIterations(value);
      }
      if (entry.customType === "prompt-autoresearch-job") {
        latestSnapshot = (entry.data as JobSnapshot) ?? latestSnapshot;
      }
    }
    renderSnapshotIntoUi(ctx, latestSnapshot);
  };

  pi.registerMessageRenderer("prompt-autoresearch-update", (message, _options, theme) => {
    const details = (message.details ?? {}) as Partial<JobSnapshot> & { kind?: string };
    const kind = details.kind ?? "update";
    const color = statusColor(kind);
    const lines: string[] = [
      `${theme.fg(color, theme.bold(`[${kind.toUpperCase()}]`))} ${message.content}`,
    ];
    if (kind === "completed") {
      lines.push(
        `${theme.fg("muted", "baseline")}: ${formatScore(details.baselineScore)}  ${theme.fg("muted", "best")}: ${formatScore(details.bestScore)}  ${theme.fg("muted", "improvement")}: ${theme.fg("success", formatSignedPercent(details.overallImprovementPct))}`,
      );
      lines.push(
        `${theme.fg("muted", "iterations")}: ${details.currentIteration ?? 0}/${details.totalIterations ?? 0}  ${theme.fg("muted", "accepted")}: ${details.acceptedCount ?? 0}  ${theme.fg("muted", "discarded")}: ${details.discardedCount ?? 0}`,
      );
      lines.push(theme.fg("muted", `prompt saved to ${PROMPT_FILE_NAME}`));
    } else {
      lines.push(
        `${theme.fg("muted", "iter")}: ${details.currentIteration ?? 0}/${details.totalIterations ?? 0}  ${theme.fg("muted", "best")}: ${formatScore(details.bestScore)}  ${theme.fg("muted", "best gain")}: ${formatSignedPercent(details.overallImprovementPct)}`,
      );
      lines.push(
        `${theme.fg("muted", "current vs best")}: ${formatSignedPercent(details.currentCandidateVsBestPct)}  ${theme.fg("muted", "current vs baseline")}: ${formatSignedPercent(details.currentCandidateVsBaselinePct)}`,
      );
    }
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => restoreConfig(ctx));
  pi.on("session_switch", async (_event, ctx) => restoreConfig(ctx));
  pi.on("session_fork", async (_event, ctx) => restoreConfig(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreConfig(ctx));
  pi.on("session_shutdown", async () => {
    stopLiveRenderTimer();
    if (!activeJob) return;
    activeJob.pauseRequested = false;
    activeJob.paused = false;
    activeJob.abortController.abort();
    for (const resolve of activeJob.resumeResolvers) resolve();
    activeJob.resumeResolvers = [];
  });

  pi.registerCommand("autoresearch", {
    description:
      "Run prompt autoresearch with eval-suite scoring and blind A/B comparison. Usage: /autoresearch [--iterations N] <goal>",
    handler: async (args, ctx) => {
      const parsed = parseAutoresearchArgs(args, defaultIterations);
      if (!parsed.goal) {
        ctx.ui.notify("Usage: /autoresearch [--iterations N] <goal>", "warning");
        return;
      }
      if (
        activeJob &&
        (activeJob.snapshot.status === "running" ||
          activeJob.snapshot.status === "paused" ||
          activeJob.snapshot.status === "pause-requested")
      ) {
        ctx.ui.notify(
          "An autoresearch job is already active. Use /autoresearch-pause, /autoresearch-resume, or /autoresearch-kill.",
          "warning",
        );
        return;
      }

      const goalSummary = await generateGoalSummary(ctx, parsed.goal);
      const snapshot: JobSnapshot = createInitialJobSnapshot({
        goal: parsed.goal,
        goalSummary,
        iterations: parsed.iterations,
        evalCaseCount: DEFAULT_EVAL_CASES,
      });
      activeJob = {
        snapshot,
        abortController: new AbortController(),
        pauseRequested: false,
        paused: false,
        resumeResolvers: [],
      };
      await persistSnapshot(ctx, snapshot);
      renderSnapshotIntoUi(ctx, snapshot);
      sendLifecycleMessage(snapshot, "started");
      ctx.ui.notify("Autoresearch started in background", "info");

      void (async () => {
        try {
          const summary = await runAutoresearch(
            ctx,
            parsed.goal,
            parsed.iterations,
            DEFAULT_EVAL_CASES,
            {
              onProgress: (message) =>
                updateSnapshot(ctx, {
                  status:
                    latestSnapshot?.status === "pause-requested"
                      ? "pause-requested"
                      : activeJob?.paused
                        ? "paused"
                        : "running",
                  message,
                }),
              onStateChange: async (patch) => {
                const previousBest = latestSnapshot?.bestScore;
                await updateSnapshot(ctx, patch, shouldPersistPatch(patch));
                const next = latestSnapshot;
                if (!next) return;
                if (patch.status === "paused") return;
                if (
                  patch.phase === "kept-candidate" &&
                  patch.bestScore !== undefined &&
                  patch.bestScore !== previousBest
                ) {
                  sendLifecycleMessage(next, "improved", { previousBestScore: previousBest });
                }
              },
              beforeStep: async () => {
                await waitIfPaused(ctx);
              },
            },
            activeJob.abortController.signal,
          );
          const { acceptedCount: accepted, discardedCount: discarded } = countAttemptResults(
            summary.attempts,
          );
          const details: RunToolDetails = {
            ...summary,
            acceptedCount: accepted,
            discardedCount: discarded,
          };
          if (latestSnapshot) {
            latestSnapshot = completeSnapshot(latestSnapshot, {
              currentIteration: parsed.iterations,
              currentScore: summary.best.evaluation.score,
              bestScore: summary.best.evaluation.score,
              acceptedCount: accepted,
              discardedCount: discarded,
              baselineScore: summary.baseline.evaluation.score,
              bestPrompt: summary.best.prompt,
              overallImprovementPct: computeRelativeImprovement(
                summary.best.evaluation.score,
                summary.baseline.evaluation.score,
              ),
              message: `Finished. Best score ${summary.best.evaluation.score.toFixed(1)} (${formatSignedPercent(computeRelativeImprovement(summary.best.evaluation.score, summary.baseline.evaluation.score))} over baseline).`,
            });
            if (activeJob) activeJob.snapshot = latestSnapshot;
            renderSnapshotIntoUi(ctx, latestSnapshot);
            await persistSnapshot(ctx, latestSnapshot);
          }
          if (latestSnapshot) sendLifecycleMessage(latestSnapshot, "completed");
          pi.sendMessage({
            customType: "prompt-autoresearch-result",
            content: buildRunSummaryMessage(summary),
            display: true,
            details,
          });
          const improvementPct = computeRelativeImprovement(
            summary.best.evaluation.score,
            summary.baseline.evaluation.score,
          );
          const improvementStr =
            improvementPct !== undefined && Number.isFinite(improvementPct)
              ? ` (${formatSignedPercent(improvementPct)} over baseline)`
              : "";
          ctx.ui.notify(
            `Autoresearch finished. Best score: ${summary.best.evaluation.score.toFixed(1)}${improvementStr}`,
            "success",
          );
        } catch (error) {
          const message = (error as Error).message;
          const killed = activeJob?.abortController.signal.aborted || /aborted/i.test(message);
          if (latestSnapshot) {
            latestSnapshot = killed
              ? applySnapshotPatch(latestSnapshot, {
                  status: "killed",
                  phase: "killed",
                  message: "Autoresearch killed.",
                })
              : failSnapshot(latestSnapshot, message);
            if (activeJob) activeJob.snapshot = latestSnapshot;
            renderSnapshotIntoUi(ctx, latestSnapshot);
            await persistSnapshot(ctx, latestSnapshot);
          }
          if (latestSnapshot) sendLifecycleMessage(latestSnapshot, killed ? "killed" : "failed");
          ctx.ui.notify(
            killed ? "Autoresearch killed" : `Autoresearch failed: ${message}`,
            killed ? "warning" : "error",
          );
        } finally {
          if (activeJob) {
            for (const resolve of activeJob.resumeResolvers) resolve();
          }
          activeJob = null;
        }
      })();
    },
  });

  pi.registerCommand("autoresearch-pause", {
    description: "Pause the active autoresearch job at the next safe checkpoint",
    handler: async (_args, ctx) => {
      if (!activeJob || activeJob.snapshot.status !== "running") {
        ctx.ui.notify("No running autoresearch job.", "warning");
        return;
      }
      activeJob.pauseRequested = true;
      if (latestSnapshot) {
        latestSnapshot = requestPause(latestSnapshot);
        if (activeJob) activeJob.snapshot = latestSnapshot;
        renderSnapshotIntoUi(ctx, latestSnapshot);
        await persistSnapshot(ctx, latestSnapshot);
      }
      ctx.ui.notify("Pause requested", "info");
    },
  });

  pi.registerCommand("autoresearch-resume", {
    description: "Resume a paused autoresearch job",
    handler: async (_args, ctx) => {
      if (!activeJob || !activeJob.paused) {
        ctx.ui.notify("No paused autoresearch job.", "warning");
        return;
      }
      activeJob.paused = false;
      activeJob.pauseRequested = false;
      const resolvers = [...activeJob.resumeResolvers];
      activeJob.resumeResolvers = [];
      if (latestSnapshot) {
        latestSnapshot = resumeSnapshot(latestSnapshot);
        if (activeJob) activeJob.snapshot = latestSnapshot;
        renderSnapshotIntoUi(ctx, latestSnapshot);
        await persistSnapshot(ctx, latestSnapshot);
        sendLifecycleMessage(latestSnapshot, "resumed");
      }
      for (const resolve of resolvers) resolve();
      ctx.ui.notify("Autoresearch resumed", "success");
    },
  });

  pi.registerCommand("autoresearch-kill", {
    description: "Kill the active autoresearch job",
    handler: async (_args, ctx) => {
      if (!activeJob) {
        ctx.ui.notify("No active autoresearch job.", "warning");
        return;
      }
      activeJob.pauseRequested = false;
      activeJob.paused = false;
      activeJob.abortController.abort();
      const resolvers = [...activeJob.resumeResolvers];
      activeJob.resumeResolvers = [];
      for (const resolve of resolvers) resolve();
      if (latestSnapshot) {
        latestSnapshot = killSnapshot(latestSnapshot);
        if (activeJob) activeJob.snapshot = latestSnapshot;
        renderSnapshotIntoUi(ctx, latestSnapshot);
        await persistSnapshot(ctx, latestSnapshot);
      }
      ctx.ui.notify("Autoresearch kill requested", "warning");
    },
  });

  pi.registerCommand("autoresearch-status", {
    description: "Show the current autoresearch job status",
    handler: async (_args, ctx) => {
      if (!latestSnapshot) {
        ctx.ui.notify("No autoresearch job has run in this session yet.", "info");
        return;
      }
      renderSnapshotIntoUi(ctx, latestSnapshot);
      ctx.ui.notify(`Autoresearch ${latestSnapshot.status}: ${latestSnapshot.message}`, "info");
    },
  });

  pi.registerCommand("autoresearch-benchmark", {
    description:
      "Benchmark a prompt across repeated eval-suite runs. Usage: /autoresearch-benchmark [--runs N] <goal>",
    handler: async (args, ctx) => {
      const parsed = parseBenchmarkArgs(args);
      if (
        activeJob &&
        (activeJob.snapshot.status === "running" ||
          activeJob.snapshot.status === "paused" ||
          activeJob.snapshot.status === "pause-requested")
      ) {
        ctx.ui.notify(
          "Finish or stop the active autoresearch job before starting a benchmark.",
          "warning",
        );
        return;
      }
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
        ctx.ui.notify(
          `Benchmark finished. Mean score: ${benchmark.meanScore.toFixed(1)}`,
          "success",
        );
      } catch (error) {
        ctx.ui.notify(`Benchmark failed: ${(error as Error).message}`, "error");
      } finally {
        renderSnapshotIntoUi(ctx, latestSnapshot);
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
      "Run prompt improvement with eval-suite execution, scoring, blind A/B comparison, and keep/discard decisions.",
    promptSnippet:
      "Improve a prompt over multiple evaluated iterations and return the best prompt found",
    promptGuidelines: [
      "Use this tool when the user asks for automatic prompt optimization or iterative prompt improvement.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "The task or outcome the optimized prompt should achieve" }),
      iterations: Type.Optional(
        Type.Number({
          description:
            "Iteration count. Default is 10 unless the user configured a higher default.",
        }),
      ),
      evalCases: Type.Optional(
        Type.Number({ description: "How many eval cases to generate. Default 5, max 8." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const iterations = clampIterations(params.iterations ?? defaultIterations);
      const evalCaseCount = clampEvalCaseCount(params.evalCases ?? DEFAULT_EVAL_CASES);
      onUpdate?.({
        content: [{ type: "text", text: `Running autoresearch (${iterations} iterations)...` }],
      });
      const summary = await runAutoresearch(
        ctx,
        params.goal,
        iterations,
        evalCaseCount,
        {
          onProgress: (message) => {
            onUpdate?.({ content: [{ type: "text", text: message }] });
          },
        },
        signal,
      );
      const { acceptedCount: accepted, discardedCount: discarded } = countAttemptResults(
        summary.attempts,
      );
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
        `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("prompt autoresearch"))} ${theme.fg("accent", details.best.evaluation.score.toFixed(1))}`,
      );
      lines.push(theme.fg("muted", `goal: ${details.goal}`));
      lines.push(
        theme.fg(
          "muted",
          `iterations: ${details.iterations} | eval cases: ${details.evalCases.length} | accepted: ${details.acceptedCount} | discarded: ${details.discardedCount}`,
        ),
      );
      lines.push("");
      lines.push(theme.fg("accent", "Eval suite:"));
      for (const evalCase of details.evalCases) {
        const caseEval = details.best.evaluation.caseEvaluations.find(
          (item) => item.caseId === evalCase.id,
        );
        lines.push(
          `- ${evalCase.title}: ${(caseEval?.score ?? 0).toFixed(1)} | ${caseEval?.summary ?? ""}`,
        );
      }
      if (expanded) {
        lines.push("");
        lines.push(theme.fg("accent", "Iteration log:"));
        for (const attempt of details.attempts) {
          lines.push(
            `- ${attempt.iteration}. ${attempt.accepted ? "kept" : "discarded"} | ${attempt.evaluation.score.toFixed(1)} | compare ${attempt.comparison.winner} | ${attempt.evaluation.summary}`,
          );
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
    promptGuidelines: [
      "Use this tool when the user asks for benchmark runs, stability, variance, or confidence in prompt quality.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "The prompt or goal to benchmark" }),
      runs: Type.Optional(
        Type.Number({ description: "How many benchmark repetitions to run. Default 3, max 10." }),
      ),
      evalCases: Type.Optional(
        Type.Number({ description: "How many eval cases to generate. Default 5, max 8." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runs = clampBenchmarkRuns(params.runs ?? DEFAULT_BENCHMARK_RUNS);
      const evalCaseCount = clampEvalCaseCount(params.evalCases ?? DEFAULT_EVAL_CASES);
      onUpdate?.({ content: [{ type: "text", text: `Running benchmark (${runs} runs)...` }] });
      const evalCases = await generateEvalCases(ctx, params.goal, evalCaseCount, signal);
      const benchmark = await benchmarkPrompt(
        ctx,
        params.goal,
        params.goal.trim(),
        evalCases,
        runs,
        (message) => {
          onUpdate?.({ content: [{ type: "text", text: message }] });
        },
        signal,
      );
      return {
        content: [{ type: "text", text: buildBenchmarkSummaryMessage(benchmark) }],
        details: benchmark,
      };
    },
  });
}
