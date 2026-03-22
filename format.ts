import type { AttemptRecord, BenchmarkSummary, EvalCase, RunSummary } from "./types.ts";
import { countAttemptResults, shorten } from "./normalize.ts";
import { PROMPT_FILE_NAME } from "./prompt-file.ts";

const HISTORY_PREVIEW_LIMIT = 6;

export function buildHistorySummary(attempts: AttemptRecord[]): string {
  if (attempts.length === 0) return "No prior iterations yet.";
  return attempts
    .slice(-HISTORY_PREVIEW_LIMIT)
    .map((attempt) =>
      [
        `Iteration ${attempt.iteration}: ${attempt.accepted ? "accepted" : "discarded"}`,
        `Score: ${attempt.evaluation.score.toFixed(1)}`,
        `Comparison winner: ${attempt.comparison.winner}`,
        `Change: ${attempt.changeSummary}`,
        `Hypothesis: ${attempt.hypothesis}`,
        `Evaluation: ${attempt.evaluation.summary}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function buildExecutionPrompt(promptUnderTest: string, evalCase: EvalCase): string {
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

export function buildRunSummaryMessage(summary: RunSummary): string {
  const { acceptedCount, discardedCount } = countAttemptResults(summary.attempts);
  const lines: string[] = [];
  lines.push("# Prompt autoresearch result");
  lines.push("");
  lines.push(`Goal: ${summary.goal}`);
  lines.push(`Iterations: ${summary.iterations}`);
  lines.push(`Eval cases: ${summary.evalCases.length}`);
  lines.push(`Baseline score: ${summary.baseline.evaluation.score.toFixed(1)}`);
  lines.push(`Best score: ${summary.best.evaluation.score.toFixed(1)}`);
  lines.push(`Accepted: ${acceptedCount}`);
  lines.push(`Discarded: ${discardedCount}`);
  lines.push("");
  lines.push("## Eval suite");
  for (const evalCase of summary.evalCases) {
    const caseEval = summary.best.evaluation.caseEvaluations.find(
      (item) => item.caseId === evalCase.id,
    );
    lines.push(`- ${evalCase.title}: ${caseEval?.score.toFixed(1) ?? "0.0"}`);
  }
  lines.push("");
  lines.push(`Best prompt saved to \`${PROMPT_FILE_NAME}\``);
  lines.push("");
  lines.push("## Iteration log");
  for (const attempt of summary.attempts) {
    lines.push(
      `- Iteration ${attempt.iteration}: ${attempt.accepted ? "kept" : "discarded"} | score ${attempt.evaluation.score.toFixed(1)} | compare ${attempt.comparison.winner} | ${attempt.evaluation.summary}`,
    );
  }
  return lines.join("\n");
}

export function buildBenchmarkSummaryMessage(summary: BenchmarkSummary): string {
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
  lines.push("## Runs");
  for (const run of summary.runs) {
    lines.push(`- Run ${run.runIndex}: ${run.score.toFixed(1)} | ${run.summary}`);
  }
  return lines.join("\n");
}

export { shorten };
