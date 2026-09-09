<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: babel-pr-review
description: >-
  Orchestrates Babel autonomous trusted code review, candidate collection, merge
  readiness evaluation, and ground-truth adjudication across Babel and external
  workspace repositories (e.g. DragonWake, AGES).
---

# /babel-pr-review

Unified operational entrypoint for autonomous, trusted, independent pull request and branch code review using the Babel Host Review Controller.

## 1. Dynamic Babel Discovery

Locate the active trusted Babel root:

1. Primary: `<workspace-root>/Babel-public-live`
2. Workspace Map: Check `<workspace-root>/.workspace-map.json` under `"Babel"`
3. Fallback: Search workspace directory for `Babel` repository root

Verify the trusted build is ready:
```powershell
Test-Path "$babelRoot\babel-cli\dist\index.js"
```
If missing, compile once:
```powershell
Push-Location "$babelRoot\babel-cli"; npm run build; Pop-Location
```

## 2. Trust Mode Determination

Determine the target repository and trust separation:
- **`SELF_REVIEW`**: Target repository is `gthgomez/Babel`.
  - Invariant: The review harness source commit MUST be an ancestor of the candidate's base branch (`pr.baseRefOid`).
  - Candidate code cannot alter reviewer prompt, tools, or merge gates.
- **`EXTERNAL_REPO_REVIEW`**: Target repository is outside Babel (e.g. `DragonWake`, `tools/gamedev`, `Project_Games`).
  - Invariant: Pinned clean Babel installation digest is used.
  - Target candidate changes cannot modify Babel evaluator code. Ancestry check against target base history is bypassed because Babel is external to the target repo.

## 3. Operations & Commands

### A. Collect Candidate Envelope
Produces canonical `CandidateEnvelope` with risk tier, digest, and scope:
```powershell
node "$babelRoot\babel-cli\dist\index.js" review collect --repo-root <target-repo> [--pr <number>] [--range <A..B>] [--staged] --json
```

Or via PowerShell wrapper:
```powershell
pwsh -File "$babelRoot\.agents\skills\code-review\scripts\collect-target.ps1" -Json [-Pr <number>] [-Range <A..B>] [-Staged]
```

### B. Execute Multi-Model Independent Review
Runs isolated dual-model review (`mimo-v2.5` + `longcat-2.0`) in read-only sandbox with trace-based coverage and finding verification:
```powershell
$privateState = "$env:LOCALAPPDATA\Babel\review-state"
Push-Location "$babelRoot"
npx tsx tools/babel-pr-review.mts `
  --repo-root <target-repo> `
  --state-dir $privateState `
  --pr <number> `
  [--repository <owner/repo>] `
  [--trust-mode <self|external>] `
  [--publish]
Pop-Location
```

Key artifacts produced in `$privateState/jobs/<digest>/`:
- `handoff.json`: Dual-model verdict and findings
- `completed.json`: Execution status and telemetry
- `<model>-coverage.json`: Trace-derived `ReviewCoverageReceipt`
- `<model>-independence.json`: Attestation of reviewer independence ($I_0 \dots I_4$)
- `<model>-findings.json`: Static-verified `StructuredFinding`s

### C. Evaluate Multi-Gate Merge Readiness
Synthesizes CodeReview + Tests + RemoteCI + Security into a single `MergeReadinessReceipt`:
```powershell
node "$babelRoot\babel-cli\dist\index.js" review readiness --repo-root <target-repo> --pr <number> --json
```
- Exit 0: `READY` (routine 0-touch auto-merge authorized)
- Exit 2: `REPAIR` / `INSUFFICIENT` / `ESCALATE` (repair required, merge blocked)

### D. Benchmark & Shadow Evaluation (BabelBench)
Inspect benchmark fixtures and evaluate reviewer accuracy:
```powershell
node "$babelRoot\babel-cli\dist\index.js" review bench [--split <dev|holdout|canary>] --json
```

### E. Ground-Truth Outcome Adjudication
Adjudicate candidate PR review against observed GitHub merge, CI runs, and git regressions:
```powershell
node "$babelRoot\babel-cli\dist\index.js" review adjudicate --repo <owner/repo> --pr <number> --state-dir $privateState --json
```
Feeds the self-improvement flywheel without model circularity.
