---
name: ci-triage
description: >
  Classify GitHub PR CI failures (billing, setup, ratchet, typecheck, test, TUI,
  infra, flake) and recommend fixes. Use when CI is red, PR checks pending, or
  after ship-slice. Wraps <BABEL_TOOLS_ROOT>/ci-triage.ps1. Handles gh exit 8 as
  pending, not failure.
---

# /ci-triage

Diagnose PR / workflow check status with class labels and next actions.

Contract: `<BABEL_TOOLS_ROOT>/ci-triage.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/ci-triage` | Auto-detect PR for current branch |
| `/ci-triage -Pr 151` | Triage that PR |
| `/ci-triage -Pr 151 -Logs` | Include annotations / log excerpts |
| `/ci-triage -Watch -Pr 151` | Poll until not pending |
| "why is CI red", "PR checks", "triage CI" | Same |

## Commands

```powershell
pwsh -File <BABEL_TOOLS_ROOT>/ci-triage.ps1 -Pr 151
pwsh -File <BABEL_TOOLS_ROOT>/ci-triage.ps1 -Pr 151 -Logs -Json
pwsh -File <BABEL_TOOLS_ROOT>/ci-triage.ps1 -Watch -Pr 151
pwsh -File <BABEL_TOOLS_ROOT>/ci-triage.ps1 -RunId 29532798599 -Logs
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | All green (or empty with `-AllowEmpty`) |
| 1 | One or more failures |
| 2 | Usage / API / missing `gh` |
| 8 | Checks pending (same convention as `gh pr checks`) |

## Failure classes

`billing` · `infra` · `setup` · `ratchet` · `typecheck` · `lint` · `build` · `test` · `tui` · `flake` · `unknown`

## Integration

| Tool | Hook |
|------|------|
| `ship-slice` | After draft PR, invoke `ci-triage -Pr N` instead of raw `gh pr checks` only |
| `/handoff-repro` | Session continuity for product work; ci-triage for GitHub status |
| Self-hosted CI | `billing` / `infra` classes point at runner start + billing settings |

## Notes

- Prefer `statusCheckRollup` field (not invalid `statusChecks`).
- Pending is not failure — do not treat exit 8 as red CI.
