# Babel curated evaluation core

This initial slice is a reusable behavioral harness, not a leaderboard or a model-performance result.

| Task | Source | Category | Check |
| --- | --- | --- | --- |
| `csv-rollup-cli` | Babel original | Terminal/data processing | Independently recomputed deduplicated CSV output |
| `repo-map-read-only` | Babel original | Read-only repository exploration | Exact architecture report plus executable authorization behavior |

Each task pins its UTF-8 solver fixture content (canonical LF) and Git-style executable modes with SHA-256. Checkout umask and Windows writable bits do not change the digest. The manifest also declares image digest, resource/time/turn/token limits, expected artifacts, scoring, and permitted workspace changes.

## No-spend selection

```sh
node benchmarks/curated-eval/runner.mjs --list
node benchmarks/curated-eval/runner.mjs --plan \
  --category terminal_data_processing \
  --budget-turns 6 \
  --requested-model deepseek-v4.1-flash \
  --output /tmp/babel-curated-plan.json
```

Repeat `--category` or `--task` for multiple selections. Turn, seconds, token, and known-dollar budgets are summed in manifest order. A dry run creates no provider client and makes zero requests.

## Tests

```sh
node --test benchmarks/curated-eval/tests/*.test.mjs
```

The existing CLI `test:benchmark-eval` hosted gate also runs this suite. It exercises deterministic fixtures without Docker, credentials or provider requests.

The deterministic oracle test requires each broken/no-op fixture to fail, a trusted reference control to pass, and a deliberately broken artifact to fail. CSV submissions must generate their output in the solver before grading; grading checks the submitted output against immutable fixture input and never executes submission code. The repository verifier compares protected source with its trusted fixture and imports only that trusted source. These fixed-fixture checks do not establish general behavior on unseen inputs.

The grader checks the complete copied workspace against the catalog's change policy before invoking its trusted verifier. It runs in a separate no-network container with read-only solver, oracle and suite mounts; only its report mount is writable. Oracle/reference files are never mounted in the solver. Zero GPUs omit the Docker GPU request. Host oracle controls do not qualify the actual Docker isolation path.

`adapters/chat-engine-result.mjs` maps an already completed Babel `ChatResult` into the versioned report schema. It does not invoke ChatEngine or dispatch provider requests. The live solver/provider route is not integrated here; task and grader containers are offline, and the separate OpenCode Go transport is not yet an installed-CLI route. This core slice has not had its pinned Docker image execution qualified in this environment.

Reports keep `session_completed` separate from the scorer's `patch_correct`. A completed session needs a completed status and an engine outcome of `VERIFIED_COMPLETE`, `UNVERIFIED_PATCH` or `NO_CHANGE_REQUIRED`; missing terminal evidence is `null`. An explicit blocked or failed engine outcome vetoes a conflicting completed status. `UNVERIFIED_PATCH` can still earn `valid_success` when the independent oracle passes and all changes satisfy the task policy. A blocked, cancelled or truncated session can retain a correct patch verdict without counting as a completed success. Oracle correctness is `null` when the grader has not run or is unavailable.

The scorer flags `false_complete` when an explicit completion claim contradicts a known failed oracle, incomplete session or unauthorized change. Missing grading evidence prevents acceptance and leaves patch correctness unknown; it does not establish a false claim. An unset flag does not establish transcript truthfulness.

These fields interpret structured engine results. They do not adjudicate verification claims in raw transcripts, qualify a hidden grader boundary, or prove truthful blocked/no-op acceptance for the research pilot's different task contracts. The deterministic controls are synthetic and provide no comparative model-performance evidence.
