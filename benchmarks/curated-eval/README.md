# Babel curated evaluation core

This initial slice is a reusable behavioral harness, not a leaderboard or a model-performance result.

| Task | Source | Category | Check |
| --- | --- | --- | --- |
| `csv-rollup-cli` | Babel original | Terminal/data processing | Independently recomputed deduplicated CSV output |
| `repo-map-read-only` | Babel original | Read-only repository exploration | Exact architecture report plus executable authorization behavior |

Each task pins its solver fixture content and modes with SHA-256, and declares image digest, resource/time/turn/token limits, expected artifacts, scoring, and permitted workspace changes in `manifest.json`.

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

The deterministic oracle test requires each broken/no-op fixture to fail, a grader-authored reference repair to pass, and a deliberately broken repair to fail. The scorer checks added, modified, and deleted files against an allowlist and requires a passing behavioral verifier. The grader runs in a separate no-network container with a read-only solver copy and oracle mount.

`adapters/chat-engine-result.mjs` maps an already completed Babel `ChatResult` into the versioned report schema. It does not invoke ChatEngine or dispatch provider requests. The live solver/provider route is not integrated here; task and grader containers are offline, and the separate OpenCode Go transport is not yet an installed-CLI route. This core slice has not had its pinned Docker image execution qualified in this environment.
