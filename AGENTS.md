# AGENTS.md

Guidance for agents working in this repository.

## Project overview

This repo is a **pi extension** for prompt optimization / prompt autoresearch.

Main behavior:
- runs iterative prompt improvement loops
- generates eval cases
- scores prompt candidates
- performs blind A/B comparisons
- keeps/discards candidates
- exposes both slash commands and LLM-callable tools
- provides interactive UI progress for running jobs

## Important files

- `index.ts` — main extension entrypoint
- `utils.ts` — pure helper utilities; preferred place for small testable logic
- `job-state.ts` — pure job snapshot / lifecycle transitions
- `README.md` — user-facing usage docs
- `test/utils.test.mjs` — tests for helper logic
- `test/job-state.test.mjs` — tests for job lifecycle/state logic
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
  - footer/status summary
  - milestone updates in chat
  - background job control for autoresearch

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
