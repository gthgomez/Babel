<!--
status: ACTIVE
last_verified: 2026-09-13
-->
# Reviewer scope: production gate vs. benchmark arms

This document records which reviewer is authoritative for Babel's merge gate and
where a Claude/Anthropic reviewer may run. It is the scope contract that the
guards in `babel-cli/src/claude-babel-astra-lab/claudeHarness.ts` and
`babel-cli/src/services/independentReviewProvider.ts` enforce.

## Production merge gate

- The **only** production reviewer is the **Babel chat reviewer on OpenCode Go**.
- It is invoked through `tools/babel-pr-review.mts`.
- No other reviewer, model, or provider is part of the merge gate. A PR must not
  be gated on a Claude/Anthropic review.
- The operational contract for the gate lives in `docs/BABEL_PR_REVIEW.md`.

## Claude Code is benchmark-only

- A **Claude Code** reviewer may run **only** as the `claude-code` arm of the
  `claude-babel-astra-lab` benchmark.
- It is never part of the production review path and must never gate a merge.
- The benchmark CLI is spawned only by
  `babel-cli/src/claude-babel-astra-lab/claudeHarness.ts`
  (`observeClaudeVersion`, `runClaudeProcess`, and `runClaudeLiveCase`) and by
  the comparison runner `babel-cli/scripts/claude-babel-astra-lab/run_comparison.ts`.

## The legacy pluggable coordinator is not the gate

- `babel-cli/src/commands/independentReviewCommands.ts` and
  `babel-cli/src/services/independentReviewProvider.ts` are a **legacy /
  benchmark-only** path.
- That coordinator is **not** the production merge gate. The production gate is
  the Babel chat reviewer described above.
- The legacy path must not be treated as merge authority and must not be used to
  substitute a Claude/Anthropic reviewer for the Babel chat reviewer.

## Opt-in environment variables

Both guards fail closed: without the exact opt-in value they throw a typed error
that names the missing variable.

| Variable | Exact value | Scope |
| --- | --- | --- |
| `BABEL_BENCH_ALLOW_CLAUDE` | `1` | Allows the Claude Code CLI to be spawned by the `claude-babel-astra-lab` benchmark (`claudeHarness.ts` and the comparison runner). |
| `BABEL_ALLOW_EXTERNAL_REVIEWER` | `1` | Allows the legacy pluggable coordinator to construct a Claude/Anthropic reviewer. Not the production gate. |

Any value other than the exact string `1` is treated as absent. These variables
exist solely to keep the benchmark arm explicit and auditable; they do not change
the production gate.
