<!--
status: EXPERIMENTAL
authority: non-normative
last_verified: 2026-08-15
-->
# Multi-Agent Orchestration

> **Status:** EXPERIMENTAL — this documents the current bounded agent-team capability,
> non-normative and subordinate to
> [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md).
> It replaces the retired "Babel Full" product design (archived:
> [BABEL_FULL_ORCHESTRATION.md](../archive/architecture/BABEL_FULL_ORCHESTRATION.md)).

## What exists today

Babel ships a **spec-contract agent-team surface** for bounded, isolated multi-agent runs.
It is an internal/advanced capability, not a product mode: the daily lanes remain
`babel "<task>"` (chat), `babel plan`, and `babel deep`.

```text
babel agents               # list prior agent-team runs
babel agents list          # same, JSON with --json
babel agents contract      # print the live-subagent isolation contract
babel agents run <spec>    # run an agent-team spec file (JSON)
babel agents inspect <id>  # inspect an agent-team run
babel agents merge <id>    # merge a ready agent-team run (pre-merge snapshot taken)
babel agents restore <id>  # restore files from the pre-merge snapshot
```

Implementation anchors: `babel-cli/src/commands/coreCommands.ts` (command surface),
`babel-cli/src/agent/implementWorktreeAgent.ts` (mutation-capable implement child in an
isolated git worktree with a required disjoint `write_scope` path allowlist),
`babel-cli/src/agent/exploreFeederAgent.ts` and `babel-cli/src/agent/reviewOnDiffAgent.ts`
(read-only support agents).

## Invariants (verified)

- **Subagent isolation is worktree-scoped.** A mutation-capable implement agent runs inside
  an isolated git worktree; the parent working tree must remain clean of child writes.
- **Write scope is required and disjoint.** Implement agents require a non-empty `write_scope`
  allowlist; the scope is validated (required, non-absolute, no escapes).
- **Merge is snapshot-based.** Merging an agent-team run takes a pre-merge snapshot; the
  same surface can restore it.
- **No consensus voting as verification.** Group outcomes never substitute for verifier
  receipts; verification authority stays with the kernel/verifier contract (harness-v1 §6.8).
- **Read-only agents stay read-only.** Explore/review agents produce evidence only.
- **Spec files are contracts.** `babel agents run <spec>` executes a declared spec; failed
  runs exit non-zero.

## Non-goals (do not resurrect)

This document does **not** describe:

- "Babel Full" as a competing product mode (retired — see archive);
- shared-worktree uncontrolled mutation;
- consensus voting as verification;
- mutating subagents without isolation and evidence;
- any removed Lite verbs (`ask`, `do`, `fix`, `propose`, `patch`, `review`).

## Authority

- Normative runtime: [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md)
- Historical design context: [BABEL_FULL_ORCHESTRATION.md](../archive/architecture/BABEL_FULL_ORCHESTRATION.md)
