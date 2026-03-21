# AGENTS.md

Guidance for agents working in this repository.

## Project overview

This repo is a **pi extension** for prompt optimization / prompt autoresearch.

Main behavior:
- runs iterative prompt improvement loops
- generates an initial prompt from the user goal before optimization starts
- generates eval cases
- scores prompt candidates
- performs blind A/B comparisons
- keeps/discards candidates
- exposes both slash commands and LLM-callable tools
- provides interactive UI progress for running jobs
- writes `AUTORESEARCH_PROMPT.md` in the current working directory with the raw best prompt text, updated at each iteration
- keeps progress state internal (pi session entries and live UI widget)

## Important files

- `index.ts` — main extension entrypoint and pi runtime wiring
- `utils.ts` — pure helper utilities; preferred place for small testable logic
- `job-state.ts` — pure job snapshot / lifecycle transitions
- `prompt-file.ts` — exports the prompt file name constant
- `README.md` — user-facing usage docs
- `test/utils.test.mjs` — tests for helper logic
- `test/job-state.test.mjs` — tests for job lifecycle/state logic
- `test/prompt-file.test.mjs` — tests for prompt file constant
- `package.json` — package metadata and test scripts

## Commands and tools

Interactive commands:
- `/autoresearch`
- `/autoresearch-benchmark`
- `/autoresearch-iterations`
- `/autoresearch-pause`
- `/autoresearch-resume`
- `/autoresearch-kill`
- `/autoresearch-status`

LLM-callable tools:
- `run_prompt_autoresearch`
- `benchmark_prompt_autoresearch`

## Development conventions

- Keep `index.ts` as the pi wiring layer.
- Prefer putting pure logic into small modules like `utils.ts` or `job-state.ts`.
- When adding behavior that can be tested without pi runtime, extract it and add tests.
- Keep interactive UI changes concise and readable; this extension values a clean TUI.
- Preserve current UX:
  - progress widget above editor
  - AI-generated goal summary in the widget
  - footer/status summary
  - milestone updates in chat
  - background job control for autoresearch
  - elapsed time / ETA display with live UI refresh while running
  - current case progress and current case title

## Testing

Run tests with:

```bash
npm test
```

Current test stack:
- Node built-in test runner (`node --test`)
- `.mjs` test files
- no external test framework required

When adding logic:
- add/extend unit tests for pure helpers
- add/extend state-transition tests for job lifecycle behavior
- avoid introducing untestable logic when a pure function extraction is easy

## Editing guidance

- Read files before editing.
- Make focused changes.
- Update `README.md` when user-facing commands or behavior change.
- If introducing new state transitions or snapshot fields, update both:
  - `job-state.ts`
  - tests in `test/job-state.test.mjs`

## Notes about runtime

This package is intended to run inside pi, so local validation is mostly:
- unit tests
- careful review of TypeScript changes
- keeping side effects localized in `index.ts`

If runtime-specific UI behavior is changed, document it in `README.md`.
