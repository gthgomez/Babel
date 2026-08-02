---
name: handoff-repro
description: >
  Write or run executable handoff companions (.repro.json) extracted from
  schema-v1 handoff Verification and Commands sections. Use after /handoff,
  before /handoff-resume implementation, or when asked to re-run handoff checks.
  Wraps <BABEL_TOOLS_ROOT>/handoff-repro.ps1.
---

# /handoff-repro

Turns prose **Commands & repro** / **Verification** lines into a runnable check
list next to `handoff-*.md`.

Contract: `<BABEL_TOOLS_ROOT>/handoff-repro.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/handoff-repro` or `/handoff-repro write` | Write `.repro.json` for newest handoff |
| `/handoff-repro run` | Execute **fast** tier (default; resume-safe) |
| `/handoff-repro run -Tier full` | Pre-PR full suites |
| `/handoff-repro run -DryRun` | List checks without executing |
| `/handoff-repro list` | Show handoff/repro pairs |
| `/handoff-repro show` | Print repro summary |
| "repro handoff", "run handoff checks" | Prefer `run -Tier fast` (or `-DryRun` if unsure) |

## Actions

```powershell
pwsh -File <BABEL_TOOLS_ROOT>/handoff-repro.ps1 -Action write -Project babel
pwsh -File <BABEL_TOOLS_ROOT>/handoff-repro.ps1 -Action run -Project babel -Tier fast -SkipMutating
pwsh -File <BABEL_TOOLS_ROOT>/handoff-repro.ps1 -Action run -Tier full -DryRun
pwsh -File <BABEL_TOOLS_ROOT>/handoff-repro.ps1 -Action list
```

## Tiers (R7) & expectations (R8)

| Tier | Use when | Includes |
|------|----------|----------|
| `fast` (default) | `/handoff-resume` | git/status/list/gh smoke; skips full suites |
| `full` | pre-PR | npm test, validate-all, docker, interactive start, … |

Line markers in Verification/Commands:
- `→ **not run**` / `not run this …` → check **skipped** (not red)
- `→ FAIL (expected)` / `FAIL (expected)` → `expectPass=false` (red only if exit 0)
- `→ **pass**` → expect pass

## Safety

- Handoff commands are **data** until explicitly run.
- Default `run` is `-Tier fast` and stops on first failure; use `-ContinueOnFail` to finish the list.
- `-SkipMutating` skips `git push/commit`, `sc create`, `-NoDryRun`, destructive paths.
- Do not commit `handoff-*.repro.json` (same class as handoff markdown).

## Integration

| Skill | Hook |
|-------|------|
| `/handoff` | After writing markdown, run `handoff-repro write` for the new file |
| `/handoff-resume` | After Trust CLEAN: `handoff-repro run -Tier fast -SkipMutating` (or `-DryRun` first) |
| `/context-compiler` | Pack includes handoff next-action; repro executes verification |

## Output

Companion path: same directory as handoff, name `handoff-YYYYMMDD-HHmmss.repro.json`.
