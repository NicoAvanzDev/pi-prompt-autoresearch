import type { JobSnapshot } from './job-state.ts';
import { formatScore, formatSignedPercent, summarizeGoal } from './utils.ts';

export const PROGRESS_FILE_NAME = 'AUTORESEARCH_PROGRESS.md';
export const PROMPT_FILE_NAME = 'AUTORESEARCH_PROMPT.md';

export function renderProgressFile(snapshot: JobSnapshot, cwd: string): string {
	const lines: string[] = [];
	lines.push('# Autoresearch progress');
	lines.push('');
	lines.push(`- cwd: ${cwd}`);
	lines.push(`- status: ${snapshot.status}`);
	lines.push(`- phase: ${snapshot.phase || '—'}`);
	lines.push(`- goal: ${summarizeGoal(snapshot.goal, 160)}`);
	lines.push(`- iteration: ${snapshot.currentIteration}/${snapshot.totalIterations}`);
	lines.push(`- case: ${snapshot.currentCaseIndex}/${snapshot.totalCases}`);
	if (snapshot.currentCaseTitle) lines.push(`- current case: ${snapshot.currentCaseTitle}`);
	lines.push(`- baseline score: ${formatScore(snapshot.baselineScore)}`);
	lines.push(`- current score: ${formatScore(snapshot.currentScore)}`);
	lines.push(`- best score: ${formatScore(snapshot.bestScore)}`);
	lines.push(`- overall gain: ${formatSignedPercent(snapshot.overallImprovementPct)}`);
	lines.push(`- last accepted gain: ${formatSignedPercent(snapshot.lastAcceptedGainPct)}`);
	lines.push(`- accepted: ${snapshot.acceptedCount}`);
	lines.push(`- discarded: ${snapshot.discardedCount}`);
	lines.push(`- updated at: ${new Date(snapshot.updatedAt).toISOString()}`);
	lines.push('');
	lines.push('## Status message');
	lines.push('');
	lines.push(snapshot.message || '—');
	lines.push('');
	lines.push('## Best prompt');
	lines.push('');
	lines.push(snapshot.bestPrompt?.trim() || '_No best prompt captured yet._');
	lines.push('');
	lines.push('## Recovery notes');
	lines.push('');
	lines.push('- This file is updated during autoresearch runs.');
	lines.push('- If pi or the machine stops, recover the latest best prompt from the section above.');
	return lines.join('\n');
}
