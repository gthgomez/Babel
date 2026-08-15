# CLAUDE.md — babel-cli package

> **Scope**: Package-local operational guidance for the Babel CLI/TUI runtime.  
> **Repo-wide rules**: root [`CLAUDE.md`](../CLAUDE.md), [`AGENTS.md`](../AGENTS.md), [`ENGINEERING.md`](../ENGINEERING.md).  
> **Normative harness architecture**: [`docs/architecture/HARNESS_ARCHITECTURE_V1.md`](../docs/architecture/HARNESS_ARCHITECTURE_V1.md) (`harness-v1`).  
> **Explanatory map**: [`docs/architecture/HARNESS_OVERVIEW.md`](../docs/architecture/HARNESS_OVERVIEW.md).  
> **Changing implementation context**: [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md).

This file MUST NOT redefine harness architecture. Point to harness-v1 for norms.

## Shipping from this package

- **Ship set ≠ worktree.** “Commit all work” means the intentional OSS-safe path list after triage — not every untracked file under `babel-cli/`.
- Do not stage `context.md`, `goldenarch.md`, datasets, evidence, or machine paths. Prefer gitignored `local/` or quarantine outside the public clone.
- Full GitHub workflow contract: [`../.agents/rules/05-github-workflow.md`](../.agents/rules/05-github-workflow.md).

## Runtime harness (read first)

```text
Agent = Model + Harness
```

- Daily path: **ChatEngine** (`src/agent/chatEngine.ts`) via `chatCore.ts`.
- Governed path: **V9 pipeline** (`src/pipeline.ts`) + Stage 4 `executorLoop`.
- Shared substrate: `src/executor/kernel.ts` + `src/executor/contracts.ts`.
- Completion: model proposes → honesty gate → **`kernel.completion.decide`**.
- Plan is **read-only**; Deep is **governed** and may mutate when gates pass.

## Autonomy contract (Class A–D)

Cross-harness autonomy taxonomy ("autonomy limited by consequence, not capability") is
encoded natively in `src/config/autonomyPolicy.ts` — pure module, no V9-lane imports,
zero co-evolution debt. It maps Class A–D onto existing primitives: task-class tune
(`chatTaskClass.ts`), permission presets (`src/agent/policy.ts`), approval sessions
(`src/agent/approvalRequests.ts`), and the completion honesty gate
(`src/agent/completionGatePolicy.ts`).

- Env: `BABEL_AUTONOMY_CLASS=A|B|C|D` — consumed by `resolveChatTaskClass`
  (A→default, B→general_swe, C→governance, D→governance). Explicit
  `BABEL_CHAT_TASK_CLASS` wins. Additive; no behavior change when unset.
- Enforcement reality: Babel runs its own loop (API runners, native tool calls) —
  it does NOT delegate tool execution to Claude Code, so Claude Code's permission
  layer is not Babel's enforcement. Preset selection seam for C/D (ask/deny) is
  `chatEngine.ts:4119` (documented, not wired).

## High-risk files

| Area | Paths |
|------|--------|
| Completion | `src/agent/completionGatePolicy.ts`, `src/executor/kernel.ts` |
| Mode policy | `src/executor/contracts.ts`, `src/executor/modeController.ts` |
| Chat loop | `src/agent/chatEngine.ts`, `src/interactive/execution/chatCore.ts` |
| Pipeline | `src/pipeline.ts`, `src/pipeline/executorLoop.ts` |
| Schemas | `src/schemas/agentContracts.ts`, `src/schemas/taskEnvelope.ts` |
| Sandbox | `src/sandbox.ts`, `src/config/executionProfiles.ts` |
| Verifiers | `src/services/requiredVerifierContract.ts`, `src/agent/verifierIntegrity.ts` |

Architecture-changing edits to these paths MUST update harness-v1, ADR-012 if decisions change, conformance tests, and golden fixtures when behavior is externally observable.

## Event-loop and completion constraints

1. Do not treat model “I’m done” as `VERIFIED_COMPLETE` without honesty + kernel decide.
2. Do not allow plan mode to mutate or to accept executor verified completion.
3. Prefer authoritative project verifiers over agent-owned `_verify*` / inline probes.
4. Do not invent terminal outcomes not present in `TerminalOutcome` without schema + harness-v1 updates.
5. Default chat `maxTurns` is a high safety ceiling (200); budgets (cost/wall/stall) usually stop first — see `config/chatEngineLimits.ts`.

## Verification commands

From `babel-cli/`:

```text
npx tsc --noEmit
npx tsx --test src/executor/*.test.ts
npm run test:unit
```

From repo root:

```text
pwsh tools/check-harness-architecture.ps1
```

## Documentation co-evolution

| Document | Authority |
|----------|-----------|
| `docs/architecture/HARNESS_ARCHITECTURE_V1.md` | Normative harness |
| `docs/architecture/HARNESS_OVERVIEW.md` | Explanatory only |
| `docs/architecture/ARCHITECTURE.md` | Prompt OS + broader system |
| `PROJECT_CONTEXT.md` | Package implementation hot paths |
| This file | Package ops pointer |

Do not claim independent clean-room verification, fail-closed isolation, or unified episode streams as fully implemented unless harness-v1 labels them IMPLEMENTED and conformance tests pass.
