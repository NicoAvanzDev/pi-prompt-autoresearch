# pi prompt autoresearch

A pi extension that improves prompts with a more rigorous eval workflow inspired by the Skill Creator page:

- generates an eval suite
- runs each prompt candidate across the suite
- scores the actual outputs case-by-case
- uses a blind A/B comparator between incumbent and candidate
- keeps or discards each iteration
- can benchmark repeated runs and report variance

## Repo layout

- `index.ts` — the pi extension entrypoint
- `package.json` — pi package manifest
- `README.md`
- `.gitignore`
- `LICENSE`

## Load locally

```bash
pi --no-extensions -e ./index.ts
```

## Install as a pi package

From a local path:

```bash
pi install .
```

From npm after publishing:

```bash
pi install npm:pi-prompt-autoresearch
```

From the public git repo:

```bash
pi install git:github.com/NicoAvanzDev/pi-prompt-autoresearch
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
