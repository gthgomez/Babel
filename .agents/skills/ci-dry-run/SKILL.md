---
name: ci-dry-run
description: >
  Run CI-equivalent checks locally in Docker before pushing — build, catalog
  tests, and TUI perf benchmark. Auto-updates snapshots for Linux parity.
  Eliminates the push→fail→fix→push cycle for snapshot/type/build failures.
---

# /ci-dry-run

Run the three main CI jobs locally inside a Linux container so the result
matches GitHub Actions — but in <5 minutes instead of 30+.

Contract: invokes `tools/ci-dry-run.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/ci-dry-run` | Full local CI simulation (build + test + snapshots) |
| `/ci-dry-run --quick` | Build + typecheck only, skip tests |
| `/ci-dry-run --snapshots` | Run tests with --update-snapshots, then review diff |
| "dry run", "ci check", "pre-push check", "local CI" | Same as default |

## Workflow

1. Check Docker is running (`docker info` — if not, skill reports and stops)
2. Run `pwsh tools/ci-dry-run.ps1` with the chosen flags
3. Interpret the structured output:

### GREEN — All Clear
- Build, typecheck, and tests pass on Linux
- Snapshots match CI target
- Safe to push

### YELLOW — Snapshots Updated
- Build and typecheck pass
- Snapshots were auto-updated to match Linux output
- Review the diff with `git diff babel-cli/src/**/__snapshots__/`
- If the diff is expected (platform normalization), commit and push
- If the diff is surprising, investigate before pushing

### RED — Build/Type/Test Failure
- Error output is captured and displayed
- Fix locally before pushing
- Re-run `/ci-dry-run` to confirm fix

## Docker Requirement

This skill requires Docker Desktop or `docker` CLI. On first use:
```
docker pull node:22-alpine
```
The image is ~50 MB and is cached after first pull.

## What It Does NOT Cover

- Competitive reference gate (requires external tools)
- Full architectural budget ratchet (use `/ratchet-preflight` for that)
- E2E/multi-platform tests

## Related

- `ratchet-preflight` — file-size budget check
- `catalog-validate-all` — catalog validation trio
