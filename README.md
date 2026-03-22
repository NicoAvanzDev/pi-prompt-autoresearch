# pi prompt autoresearch

[![npm version](https://img.shields.io/npm/v/pi-prompt-autoresearch)](https://www.npmjs.com/package/pi-prompt-autoresearch)
[![license](https://img.shields.io/npm/l/pi-prompt-autoresearch)](./LICENSE)

A [pi](https://github.com/nichochar/pi) extension that **iteratively improves prompts** using execution-based evaluation, blind A/B comparison, and keep/discard decisions.

- Generates an eval suite from your goal
- Runs each prompt candidate across the suite and scores actual outputs
- Performs blind A/B comparisons between incumbent and candidate
- Keeps or discards each iteration based on eval scores and comparator preference
- Benchmarks repeated runs and reports variance

## Install

```bash
pi install npm:pi-prompt-autoresearch
```

<details>
<summary>Alternative install methods</summary>

From the public git repo:

```bash
pi install git:github.com/NicoAvanzDev/pi-prompt-autoresearch
```

From a local clone:

```bash
pi install .
```

Load without installing:

```bash
pi --no-extensions -e ./index.ts
```

</details>

## Quick start

```text
/autoresearch Write a prompt that produces a concise, factual summary of a long technical article.
```

That single command kicks off the full optimization loop. The extension will:

1. Generate an initial prompt from your goal
2. Build an eval suite tailored to the task
3. Iterate — rewrite, evaluate, compare, keep or discard — for 10 rounds (configurable)
4. Write the best prompt to `AUTORESEARCH_PROMPT.md` in your working directory

A live progress widget shows iteration count, scores, elapsed time, and ETA while it runs. When a new best prompt is found you get a milestone update in chat.

### Example session

```text
> /autoresearch Write a prompt that turns raw meeting transcripts into structured JSON notes with attendees, action items, and decisions.

  Autoresearch ━━━━━━━━━━━━━━━━━━━━ 100%  10/10 iterations
  Goal    Turn meeting transcripts into structured JSON notes
  Score   0.92 (best) — +38% vs baseline
  Status  Completed in 4m 12s

✓ Best prompt written to AUTORESEARCH_PROMPT.md
```

You can also benchmark an existing prompt to measure consistency:

```text
> /autoresearch-benchmark --runs 5 Write a prompt that extracts structured meeting notes as JSON.

  Benchmark complete — 5 runs
  Mean 0.88 · Min 0.84 · Max 0.91 · StdDev 0.03
```

## How it works

### Improve mode

For each `/autoresearch` run, the extension:

1. generates an initial prompt from the user goal
2. generates a small eval suite for the user goal
3. runs the initial prompt on every eval case
4. scores each case and computes an aggregate score
5. generates a revised prompt candidate
6. runs that candidate on every eval case
7. evaluates the candidate across the full suite
8. performs a blind **A/B comparison** between incumbent and candidate outputs
9. keeps the candidate only if:
   - the eval says `keep`
   - the aggregate score beats the current best
   - the blind comparator prefers the candidate

### Benchmark mode

The benchmark workflow:

1. generates an eval suite
2. runs the prompt multiple times across that suite
3. records per-run aggregate scores
4. reports:
   - mean score
   - min/max score
   - variance
   - standard deviation

## Commands

### Run autoresearch

```text
/autoresearch <goal>
```

Example:

```text
/autoresearch Write a prompt that produces a concise, factual summary of a long technical article.
```

Override iterations for one run:

```text
/autoresearch --iterations 20 Write a prompt that generates a JSON API migration checklist.
```

### Benchmark a prompt

```text
/autoresearch-benchmark <goal>
```

Example:

```text
/autoresearch-benchmark --runs 5 Write a prompt that extracts structured meeting notes as JSON.
```

### Change the default iteration count

```text
/autoresearch-iterations 20
```

### Control a running job

```text
/autoresearch-pause
/autoresearch-resume
/autoresearch-kill
/autoresearch-status
```

The interactive extension now shows:

- a persistent progress widget above the editor
- an AI-generated goal summary
- iteration and case progress
- elapsed time and ETA, refreshed live while a job is running
- current score, best score, and percentage improvement vs baseline
- milestone updates in chat when a new best prompt is found, or when the job is paused/resumed/completed

During a run, the extension writes `AUTORESEARCH_PROMPT.md` in the current working directory with the raw best prompt text, updated at each iteration. Progress state is kept internal to the extension (pi session entries and the live UI widget).

Pause takes effect at the next safe checkpoint between long-running steps.

## Tools

The extension exposes LLM-callable tools:

- `run_prompt_autoresearch`
- `benchmark_prompt_autoresearch`

### `run_prompt_autoresearch`

Parameters:

- `goal: string`
- `iterations?: number`
- `evalCases?: number`

### `benchmark_prompt_autoresearch`

Parameters:

- `goal: string`
- `runs?: number`
- `evalCases?: number`

## Notes

- default improve iterations: **10**
- users can increase iterations up to **100**
- default benchmark runs: **3**
- benchmark runs can go up to **10**
- default eval cases: **5**
- eval cases can go up to **8**
- in interactive mode, `/autoresearch` copies the best prompt into the editor when finished
