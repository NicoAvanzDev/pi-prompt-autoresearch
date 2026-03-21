export type JobStatus = "idle" | "running" | "pause-requested" | "paused" | "completed" | "failed" | "killed";
export type JobMode = "autoresearch" | "benchmark";

export interface JobSnapshot {
	mode: JobMode;
	status: JobStatus;
	goal: string;
	goalSummary?: string;
	iterations: number;
	evalCaseCount: number;
	currentIteration: number;
	totalIterations: number;
	currentCaseIndex: number;
	totalCases: number;
	phase: string;
	message: string;
	currentCaseTitle?: string;
	bestPrompt?: string;
	baselineScore?: number;
	currentScore?: number;
	currentCandidateVsBaselinePct?: number;
	currentCandidateVsBestPct?: number;
	bestScore?: number;
	previousBestScore?: number;
	lastAcceptedGainPct?: number;
	overallImprovementPct?: number;
	acceptedCount: number;
	discardedCount: number;
	startedAt: number;
	updatedAt: number;
}

export function createInitialJobSnapshot(input: {
	goal: string;
	goalSummary?: string;
	bestPrompt?: string;
	iterations: number;
	evalCaseCount: number;
	now?: number;
	mode?: JobMode;
}): JobSnapshot {
	const now = input.now ?? Date.now();
	return {
		mode: input.mode ?? "autoresearch",
		status: "running",
		goal: input.goal,
		goalSummary: input.goalSummary,
		bestPrompt: input.bestPrompt,
		iterations: input.iterations,
		evalCaseCount: input.evalCaseCount,
		currentIteration: 0,
		totalIterations: input.iterations,
		currentCaseIndex: 0,
		totalCases: input.evalCaseCount,
		phase: "starting",
		message: `Starting autoresearch for ${input.iterations} iterations...`,
		acceptedCount: 0,
		discardedCount: 0,
		startedAt: now,
		updatedAt: now,
	};
}

export function applySnapshotPatch(snapshot: JobSnapshot, patch: Partial<JobSnapshot>, now?: number): JobSnapshot {
	return {
		...snapshot,
		...patch,
		updatedAt: now ?? Date.now(),
	};
}

export function requestPause(snapshot: JobSnapshot, now?: number): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "pause-requested",
			message: "Pause requested. Waiting for current step to finish...",
		},
		now,
	);
}

export function enterPaused(snapshot: JobSnapshot, now?: number): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "paused",
			message: `Paused at ${snapshot.phase || "checkpoint"}.`,
		},
		now,
	);
}

export function resumeSnapshot(snapshot: JobSnapshot, now?: number): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "running",
			message: "Resuming autoresearch...",
		},
		now,
	);
}

export function killSnapshot(snapshot: JobSnapshot, now?: number): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "killed",
			phase: "killed",
			message: "Kill requested. Aborting current step...",
		},
		now,
	);
}

export function completeSnapshot(
	snapshot: JobSnapshot,
	input: {
		currentIteration: number;
		currentScore: number;
		bestScore: number;
		acceptedCount: number;
		discardedCount: number;
		baselineScore?: number;
		bestPrompt?: string;
		overallImprovementPct?: number;
		message?: string;
	},
	now?: number,
): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "completed",
			phase: "completed",
			currentIteration: input.currentIteration,
			currentScore: input.currentScore,
			bestScore: input.bestScore,
			acceptedCount: input.acceptedCount,
			discardedCount: input.discardedCount,
			baselineScore: input.baselineScore,
			bestPrompt: input.bestPrompt,
			overallImprovementPct: input.overallImprovementPct,
			message: input.message ?? `Finished. Best score ${input.bestScore.toFixed(1)}.`,
		},
		now,
	);
}

export function failSnapshot(snapshot: JobSnapshot, errorMessage: string, now?: number): JobSnapshot {
	return applySnapshotPatch(
		snapshot,
		{
			status: "failed",
			phase: "failed",
			message: `Autoresearch failed: ${errorMessage}`,
		},
		now,
	);
}

export function getStatusText(snapshot: JobSnapshot): string {
	if (snapshot.status === "running") {
		return `● autoresearch · iter ${snapshot.currentIteration}/${snapshot.totalIterations} · best ${formatMaybeScore(snapshot.bestScore)}`;
	}
	if (snapshot.status === "paused") {
		return `⏸ autoresearch paused · iter ${snapshot.currentIteration}/${snapshot.totalIterations}`;
	}
	if (snapshot.status === "pause-requested") {
		return "⏸ autoresearch pausing after current step...";
	}
	if (snapshot.status === "completed") {
		return `✓ autoresearch complete · best ${formatMaybeScore(snapshot.bestScore)}`;
	}
	if (snapshot.status === "killed") return "■ autoresearch killed";
	if (snapshot.status === "failed") return "✗ autoresearch failed";
	return "";
}

function formatMaybeScore(value: number | undefined): string {
	return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(1);
}
