# pi prompt autoresearch

A pi extension that improves prompts with a real eval loop:

- generates an eval suite
- runs each prompt candidate across the suite
- scores the actual outputs case-by-case
- aggregates the score
- keeps or discards each iteration

That is much closer to a benchmark-style eval workflow than a single one-off judge call.

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

## How the eval works

For each `/autoresearch` run, the extension:

1. generates a small eval suite for the user goal
2. uses the goal itself as the baseline prompt
3. runs the baseline prompt on every eval case
4. scores each case and computes an aggregate score
5. generates a revised prompt candidate
6. runs that candidate on every eval case
7. evaluates the candidate across the full suite
8. keeps the candidate only if the eval says `keep` **and** the aggregate score beats the current best

So the keep/discard decision is based on a multi-case eval suite, not just one generated answer.

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

### Change the default iteration count

```text
/autoresearch-iterations 20
```

## Tool

The extension exposes an LLM-callable tool:

- `run_prompt_autoresearch`

Parameters:

- `goal: string`
- `iterations?: number`

## Notes

- default iterations: **10**
- users can increase iterations up to **100**
- the extension evaluates **actual outputs** on an eval suite
- in interactive mode, `/autoresearch` copies the best prompt into the editor when finished
