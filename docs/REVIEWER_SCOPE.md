<!--
status: ACTIVE
last_verified: 2026-09-13
-->
# Reviewer scope: production gate vs. benchmark arms

This document records which reviewer is authoritative for Babel's merge gate and
where a Claude/Anthropic reviewer may run. It separates what is **mechanically
enforced by code** from what is only an **advisory convention**.

## Production merge gate

- The **only** production reviewer is the **Babel chat reviewer on OpenCode Go**.
- It is invoked through `tools/babel-pr-review.mts`.
- No other reviewer, model, or provider is part of the merge gate. A PR must not
  be gated on a Claude/Anthropic review.
- The operational contract for the gate lives in `docs/BABEL_PR_REVIEW.md`.

## Claude Code is benchmark-only

- A **Claude Code** reviewer may run as the `claude-code` arm of the
  `claude-babel-astra-lab` benchmark only. It is never part of the production
  review path and must never gate a merge.
- **Mechanically enforced:** the benchmark harness
  `babel-cli/src/claude-babel-astra-lab/claudeHarness.ts`
  (`observeClaudeVersion`, `runClaudeProcess`, `runClaudeLiveCase`) and the
  campaign entry point
  `babel-cli/src/claude-babel-astra-lab/comparison-runner.ts`
  (`runComparisonCampaign`) both call `assertClaudeBenchmarkOptIn()` and refuse
  unless `BABEL_BENCH_ALLOW_CLAUDE=1`. The comparison CLI
  `babel-cli/scripts/claude-babel-astra-lab/run_comparison.ts` additionally
  guards before importing the evaluator-supplied adapter module, so programmatic
  callers of `runComparisonCampaign` cannot bypass the opt-in.
- **Not enforced / advisory:** `babel-cli/src/runners/claudeCli.ts` is another
  spawner of the `claude` binary (through `cliBase.spawnCliProcess`). It is a
  **legacy, unregistered** public-use fallback runner (see the note in
  `execute.ts`), is not referenced by the runner waterfall or the review path,
  and does not pass through the benchmark opt-in guard. If it is ever wired into
  review, it must be covered by this scope.

## The legacy pluggable coordinator is not the gate

- `babel-cli/src/commands/independentReviewCommands.ts` and
  `babel-cli/src/services/independentReviewProvider.ts` are a **legacy /
  benchmark-only** path. They are **not** the production merge gate, and must not
  be treated as merge authority or used to substitute a Claude/Anthropic
  reviewer for the Babel chat reviewer.
- Mechanical coverage is **partial**, so the non-gate status is a convention, not
  a guarantee:
  - `createLiveIndependentReviewProvider` calls
    `assertReviewerScopeAllowed(reviewerModel, reviewProvider)`, which throws
    `ExternalReviewerNotAllowedError` unless `BABEL_ALLOW_EXTERNAL_REVIEWER=1`.
  - That check is **label-only**: it pattern-matches the `reviewerModel` /
    `reviewProvider` strings passed to the factory. It does not inspect or
    confine what `runWithPrimaryOnlyFallback` actually executes, and the default
    labels (`configured-independent-reviewer` / `babel-primary-readonly-review`)
    never match.
  - The legacy coordinator in `independentReviewCommands.ts` builds providers
    inline from persisted review handoffs or read-only fixtures and never calls
    `createLiveIndependentReviewProvider`, so `assertReviewerScopeAllowed` does
    not cover that execution path.

## Opt-in environment variables

Wherever a guard is wired in, it fails closed: without the exact value it throws
a typed error that names the missing variable. Any value other than the exact
string `1` is treated as absent.

| Variable | Exact value | Mechanical scope |
| --- | --- | --- |
| `BABEL_BENCH_ALLOW_CLAUDE` | `1` | Required by `claudeHarness.ts` (Claude Code CLI spawn) and by `runComparisonCampaign`. |
| `BABEL_ALLOW_EXTERNAL_REVIEWER` | `1` | Required by `assertReviewerScopeAllowed` when the factory options label the reviewer Claude/Anthropic. Label-only; does not cover the legacy coordinator's handoff/fixture providers. |

These variables exist solely to keep the benchmark arm explicit and auditable;
they do not change the production gate.
