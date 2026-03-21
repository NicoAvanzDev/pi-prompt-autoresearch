export function clampIterations(value: number, maxIterations = 100): number {
  return Math.max(1, Math.min(maxIterations, Math.floor(value)));
}

export function clampEvalCaseCount(value: number, maxEvalCases = 8): number {
  return Math.max(3, Math.min(maxEvalCases, Math.floor(value)));
}

export function clampBenchmarkRuns(value: number, maxBenchmarkRuns = 10): number {
  return Math.max(1, Math.min(maxBenchmarkRuns, Math.floor(value)));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

export function computeRelativeImprovement(
  current: number | undefined,
  baseline: number | undefined,
): number | undefined {
  if (current === undefined || baseline === undefined) return undefined;
  if (baseline === 0) return current === 0 ? 0 : undefined;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

export function formatSignedPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatScore(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

export function makeProgressBar(progress: number, width = 20): string {
  const safeProgress = Math.max(0, Math.min(1, progress));
  const filled = Math.round(width * safeProgress);
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}] ${Math.round(safeProgress * 100)}%`;
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function parseAutoresearchArgs(
  rawArgs: string,
  defaultIterations: number,
): { goal: string; iterations: number } {
  const match = rawArgs.match(/^\s*--iterations\s+(\d+)\s+([\s\S]+)$/i);
  if (match) return { iterations: clampIterations(Number(match[1])), goal: match[2].trim() };
  return { goal: rawArgs.trim(), iterations: defaultIterations };
}

export function parseBenchmarkArgs(
  rawArgs: string,
  defaultRuns = 3,
): { goal: string; runs: number } {
  const match = rawArgs.match(/^\s*--runs\s+(\d+)\s+([\s\S]+)$/i);
  if (match) return { runs: clampBenchmarkRuns(Number(match[1])), goal: match[2].trim() };
  return { goal: rawArgs.trim(), runs: defaultRuns };
}

export function summarizeGoal(goal: string, maxLength = 96): string {
  const singleLine = goal.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function estimateRemainingMs(
  elapsedMs: number | undefined,
  progress: number,
): number | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  if (!Number.isFinite(progress) || progress <= 0 || progress >= 1)
    return progress >= 1 ? 0 : undefined;
  return (elapsedMs / progress) * (1 - progress);
}

/**
 * Count how many consecutive discards are at the tail of the attempts list.
 * Returns 0 if the last attempt was accepted or the list is empty.
 */
export function countConsecutiveDiscards(accepted: boolean[]): number {
  let count = 0;
  for (let i = accepted.length - 1; i >= 0; i--) {
    if (accepted[i]) break;
    count++;
  }
  return count;
}

/**
 * Determine the max consecutive discards before triggering an early exit.
 * At least 3, and scales with total iterations (40% of total).
 */
export function earlyExitThreshold(totalIterations: number): number {
  return Math.max(3, Math.ceil(totalIterations * 0.4));
}

/**
 * Whether to skip the expensive A/B comparison based on score gap.
 * Returns true if the candidate is clearly worse than the best.
 */
export function shouldSkipComparison(
  candidateScore: number,
  bestScore: number,
  candidateKeep: boolean,
  threshold = 10,
): boolean {
  if (!candidateKeep) return true;
  return candidateScore < bestScore - threshold;
}
