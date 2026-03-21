# pi prompt autoresearch

A pi extension that loops on a prompt, executes each candidate, evaluates the actual result, and decides whether to keep or discard each iteration.

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

From a git repo later:

```bash
pi install git:github.com/USER/REPO
```

Because `package.json` contains a `pi` manifest, pi will load:

- `./index.ts`

## What it does

This extension runs an autoresearch loop for prompts:

1. uses the user goal as the baseline prompt
2. executes that prompt in a fresh pi subprocess
3. evaluates the actual output
4. generates a revised prompt candidate
5. executes the candidate
6. evaluates the candidate against the current best result
7. keeps or discards the iteration
8. repeats for a fixed number of iterations

By default it runs **10 iterations**.
Users can increase that up to **100**.

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

- it evaluates the **actual output** of each prompt candidate
- it only keeps a candidate when evaluation says keep **and** the score beats the current best
- in interactive mode, `/autoresearch` copies the best prompt into the editor when finished
- the package is set up in the common pi extension repo style: root `package.json` + root `index.ts`
