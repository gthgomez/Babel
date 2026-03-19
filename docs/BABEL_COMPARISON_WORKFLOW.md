# Babel Comparison Workflow (Phase 5)

## Purpose

Provide a bounded, reviewable way to compare two Babel Local task outputs without intuition-only judgment.

This workflow is pairwise Best-of-2:
- exactly two candidates per case
- explicit weighted rubric
- deterministic winner selection
- machine-parseable storage format

## When To Use

Use this workflow for important tasks where output quality should be compared across:
- models
- adapters
- client surfaces
- stack selections

Use it after both candidate runs are complete and review artifacts exist.

## Deterministic Decision Contract

Each comparison case must define:
- two candidates (`candidate_a`, `candidate_b`)
- one rubric with explicit criteria, weights, and score scale
- one score map per candidate

Score scale:
- default min: `0`
- default max: `2`
- default pass threshold for critical criteria: `1`

Winner selection order is fixed:
1. highest `weighted_total`
2. if tied, highest `critical_criteria_pass_count`
3. if tied, highest `verification_quality` score
4. if tied, lexicographically smallest candidate ID

This removes hand-wavy tie resolution.

## Storage Format

Store comparison records as JSON under `tests/fixtures/comparison-workflow/` for reviewability.

Case schema (required fields):
- `id`
- `task.project`
- `task.taskCategory`
- `task.objective`
- `rubric.scoreScale.min|max|passThreshold`
- `rubric.criteria[]` with:
  - `id`
  - `description`
  - `weight`
  - `critical`
- `candidates[]` (exactly 2) with:
  - `id`
  - `label`
  - `model`
  - `adapter`
  - `clientSurface`
  - `sessionId`
  - `selectedStackIds[]`
  - `responsePath`
- `scoring[]` (exactly 2) with:
  - `candidateId`
  - `criterionScores.{criterionId}: int`

Optional expectation block for deterministic checks:
- `expected.winnerId`
- `expected.decisionRule`
- `expected.weightedTotals.{candidateId}`
- `expected.criticalPassCounts.{candidateId}`

## Tooling

Primary scorer:
- `tools/score-comparison-results.ps1`

What it does:
- validates comparison schema constraints
- validates response artifact paths exist
- computes weighted totals and critical-pass counts
- applies deterministic tie-break rules
- emits text or JSON summaries
- emits recommendation signals from winners:
  - top winning models
  - top winning adapters
  - top winning client surfaces
  - top winning stack IDs

## Commands

Score comparisons in text mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\score-comparison-results.ps1 `
  -InputPath .\tests\fixtures\comparison-workflow\comparison-cases.json `
  -Format text
```

Score comparisons in JSON mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\score-comparison-results.ps1 `
  -InputPath .\tests\fixtures\comparison-workflow\comparison-cases.json `
  -Format json
```

Enforce expected outcomes (fixture/regression mode):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\score-comparison-results.ps1 `
  -InputPath .\tests\fixtures\comparison-workflow\comparison-cases.json `
  -Format json `
  -CheckExpected
```

Run the regression test:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-comparison-workflow.ps1
```

## Review Expectations

For each case review:
- objective and task category
- candidate stack IDs and client surfaces
- criterion-level scores and weighted contributions
- applied decision rule
- selected winner ID

This enables future recommendation tuning with evidence, not anecdote.
