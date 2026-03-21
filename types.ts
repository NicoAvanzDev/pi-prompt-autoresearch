import type { JobSnapshot } from "./job-state.ts";

export interface GeneratorResult {
  candidatePrompt: string;
  changeSummary: string;
  hypothesis: string;
}

export interface EvalCase {
  id: string;
  title: string;
  input: string;
  expectedCharacteristics: string[];
}

export interface CaseEvaluation {
  caseId: string;
  title: string;
  score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
}

export interface PromptEvaluation {
  score: number;
  keep: boolean;
  decision: "keep" | "discard";
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  caseEvaluations: CaseEvaluation[];
}

export interface ComparatorCaseDecision {
  caseId: string;
  title: string;
  winner: "A" | "B" | "tie";
  reason: string;
}

export interface ComparatorResult {
  winner: "A" | "B" | "tie";
  keepCandidate: boolean;
  summary: string;
  reasons: string[];
  caseDecisions: ComparatorCaseDecision[];
}

export interface AttemptRecord {
  iteration: number;
  candidatePrompt: string;
  evaluation: PromptEvaluation;
  comparison: ComparatorResult;
  accepted: boolean;
  changeSummary: string;
  hypothesis: string;
}

export interface PromptOutput {
  caseId: string;
  title: string;
  output: string;
}

export interface PromptRun {
  prompt: string;
  outputs: PromptOutput[];
  evaluation: PromptEvaluation;
}

export interface BenchmarkRun {
  runIndex: number;
  score: number;
  summary: string;
}

export interface BenchmarkSummary {
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

export interface RunSummary {
  goal: string;
  iterations: number;
  evalCases: EvalCase[];
  baseline: PromptRun;
  best: PromptRun;
  attempts: AttemptRecord[];
}

export interface RunToolDetails extends RunSummary {
  acceptedCount: number;
  discardedCount: number;
}

export interface ActiveJob {
  snapshot: JobSnapshot;
  abortController: AbortController;
  pauseRequested: boolean;
  paused: boolean;
  resumeResolvers: Array<() => void>;
}

export interface AutoresearchCallbacks {
  onProgress?: (message: string) => void;
  onStateChange?: (patch: Partial<JobSnapshot>) => Promise<void> | void;
  beforeStep?: () => Promise<void> | void;
}
