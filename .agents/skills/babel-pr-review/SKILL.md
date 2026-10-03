<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: babel-pr-review
description: >-
  Routes independent exact-head PR review and optional Babel certification,
  candidate collection, readiness evaluation, and outcome adjudication.
---

# /babel-pr-review

Technical reference for optional Babel PR tooling. Contributor review and merge
policy is owned only by [AGENTS.md](../../../AGENTS.md#independent-review-and-merge).
[Babel PR Review](../../../docs/BABEL_PR_REVIEW.md) describes the evidence surfaces.

Custom Babel certification and receipts are optional advisory tooling. They do
not replace independent review, the base-rooted gate, required CI, live GitHub
rules, actual merge permission, or the owner's task authorization. A changed
head invalidates earlier review coverage and check results. Do not claim process
or sandbox isolation without evidence.

The following commands apply when the task calls for the optional Babel tooling.

## 1. Dynamic Babel Discovery

Locate the task's trusted Babel installation. An optional local workspace map
can help locate a checkout; a directory name or map entry does not establish
repository identity or trust. Verify the repository and source revision before
using it. Do not run the reviewer controller from the candidate checkout.

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
  - Invariant: Babel evaluator code remains separate from the target candidate; record the trusted installation's source revision and version digest. Publishing requires a clean trusted installation.
  - Target candidate changes cannot modify Babel evaluator code. Ancestry check against target base history is bypassed because Babel is external to the target repo.

These are optional controller trust modes, not GitHub merge authorization. The
GitHub gate uses the immutable base's evaluator and risk policy; candidate code
cannot change that evaluator for its own merge.

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

### B. Execute Optional Orchestrated Review
Runs the controller's configured reviewer with trace-derived coverage and finding
verification. The current launcher uses `mimo-v2.5`; this implementation default
is not a vendor requirement for ordinary independent review. Its evidence
validators retain their own provenance, revision, and isolation requirements:
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
- `handoff.json`: Controller review verdict and findings
- `completed.json`: Execution status and telemetry
- `<model>-coverage.json`: Trace-derived `ReviewCoverageReceipt`
- `<model>-independence.json`: Computed independence class for that execution
- `<model>-findings.json`: Static-verified `StructuredFinding`s

### C. Evaluate Optional Certification Readiness
Evaluates the optional subsystem's available review and verification evidence
under its risk policy, producing a `MergeReadinessReceipt`:
```powershell
node "$babelRoot\babel-cli\dist\index.js" review readiness --repo-root <target-repo> --pr <number> --state-dir $privateState --json
```
- Exit 0: `READY` for the optional subsystem's evidence evaluation.
- Exit 2: `REPAIR` / `INSUFFICIENT` / `ESCALATE`; inspect its findings and missing evidence.

Neither exit code grants GitHub merge permission. For a Babel merge decision,
use the trusted base-rooted gate specified by the GitHub workflow, bound to the
exact reviewed head. The current gate reports `independentReviewMode: ADVISORY`
and `mergeAuthorizationSource: GITHUB_SERVER`; absent or invalid custom evidence
remains visible without becoming a custom certification prerequisite. Required
checks and their producers, live approvals and resolved threads, base freshness,
and PR/head state still govern readiness. Merge only within the owner's task
authorization and actual GitHub permissions, with an expected-head check.

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
