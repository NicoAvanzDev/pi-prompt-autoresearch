import { describe, it, expect } from "vitest";
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
} from "../job-state.ts";

describe("createInitialJobSnapshot", () => {
  it("builds a running job", () => {
    const snapshot = createInitialJobSnapshot({
      goal: "Improve summarization",
      goalSummary: "Improve summarization",
      bestPrompt: "Initial prompt body",
      iterations: 12,
      evalCaseCount: 5,
      now: 123,
    });

    expect(snapshot.status).toBe("running");
    expect(snapshot.goal).toBe("Improve summarization");
    expect(snapshot.goalSummary).toBe("Improve summarization");
    expect(snapshot.bestPrompt).toBe("Initial prompt body");
    expect(snapshot.currentIteration).toBe(0);
    expect(snapshot.totalIterations).toBe(12);
    expect(snapshot.totalCases).toBe(5);
    expect(snapshot.startedAt).toBe(123);
    expect(snapshot.updatedAt).toBe(123);
  });
});

describe("applySnapshotPatch", () => {
  it("merges fields and updates timestamp", () => {
    const initial = createInitialJobSnapshot({
      goal: "X",
      iterations: 2,
      evalCaseCount: 5,
      now: 10,
    });
    const updated = applySnapshotPatch(
      initial,
      { currentIteration: 1, phase: "run-eval-suite" },
      20,
    );

    expect(updated.currentIteration).toBe(1);
    expect(updated.phase).toBe("run-eval-suite");
    expect(updated.updatedAt).toBe(20);
    expect(updated.startedAt).toBe(10);
  });
});

describe("pause, resume, and kill transitions", () => {
  it("update status and messages", () => {
    const initial = createInitialJobSnapshot({
      goal: "X",
      iterations: 2,
      evalCaseCount: 5,
      now: 10,
    });
    const pauseRequested = requestPause(initial, 11);
    expect(pauseRequested.status).toBe("pause-requested");
    expect(pauseRequested.message).toMatch(/Pause requested/);

    const paused = enterPaused({ ...pauseRequested, phase: "compare-a-b" }, 12);
    expect(paused.status).toBe("paused");
    expect(paused.message).toMatch(/compare-a-b/);

    const resumed = resumeSnapshot(paused, 13);
    expect(resumed.status).toBe("running");
    expect(resumed.message).toBe("Resuming autoresearch...");

    const killed = killSnapshot(resumed, 14);
    expect(killed.status).toBe("killed");
    expect(killed.phase).toBe("killed");
    expect(killed.message).toMatch(/Kill requested/);
  });
});

describe("complete and fail transitions", () => {
  it("preserve summary fields", () => {
    const initial = createInitialJobSnapshot({
      goal: "X",
      iterations: 4,
      evalCaseCount: 5,
      now: 10,
    });
    const completed = completeSnapshot(
      initial,
      {
        currentIteration: 4,
        currentScore: 88,
        bestScore: 91,
        acceptedCount: 2,
        discardedCount: 2,
        baselineScore: 50,
        bestPrompt: "Best prompt body",
        overallImprovementPct: 82,
      },
      99,
    );

    expect(completed.status).toBe("completed");
    expect(completed.phase).toBe("completed");
    expect(completed.currentIteration).toBe(4);
    expect(completed.bestScore).toBe(91);
    expect(completed.bestPrompt).toBe("Best prompt body");
    expect(completed.acceptedCount).toBe(2);
    expect(completed.updatedAt).toBe(99);
    expect(completed.message).toMatch(/Finished\. Best score 91.0/);

    const failed = failSnapshot(completed, "boom", 100);
    expect(failed.status).toBe("failed");
    expect(failed.phase).toBe("failed");
    expect(failed.updatedAt).toBe(100);
    expect(failed.message).toBe("Autoresearch failed: boom");
  });
});

describe("getStatusText", () => {
  it("renders readable status summaries", () => {
    const base = createInitialJobSnapshot({ goal: "X", iterations: 3, evalCaseCount: 5, now: 10 });

    expect(getStatusText({ ...base, currentIteration: 1, bestScore: 77 })).toBe(
      "● autoresearch · iter 1/3 · best 77.0",
    );
    expect(getStatusText({ ...base, status: "paused", currentIteration: 2 })).toBe(
      "⏸ autoresearch paused · iter 2/3",
    );
    expect(getStatusText({ ...base, status: "pause-requested" })).toBe(
      "⏸ autoresearch pausing after current step...",
    );
    expect(getStatusText({ ...base, status: "completed", bestScore: 88 })).toBe(
      "✓ autoresearch complete · best 88.0",
    );
    expect(getStatusText({ ...base, status: "killed" })).toBe("■ autoresearch killed");
    expect(getStatusText({ ...base, status: "failed" })).toBe("✗ autoresearch failed");
  });
});
