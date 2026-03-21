import { summarizeGoal } from './utils.ts';
import type { JobSnapshot } from './job-state.ts';

export function renderPromptFile(snapshot: JobSnapshot): string {
	const lines: string[] = [];
	lines.push('# Autoresearch prompt');
	lines.push('');
	lines.push(`Goal: ${summarizeGoal(snapshot.goal, 160)}`);
	lines.push(`Status: ${snapshot.status}`);
	lines.push(`Phase: ${snapshot.phase || '—'}`);
	lines.push(`Iteration: ${snapshot.currentIteration}/${snapshot.totalIterations}`);
	lines.push(`Updated: ${new Date(snapshot.updatedAt).toISOString()}`);
	lines.push('');
	lines.push('---');
	lines.push('');
	lines.push(snapshot.bestPrompt?.trim() || '_No prompt captured yet._');
	lines.push('');
	return lines.join('\n');
}
