# Babel Full Orchestration Contract

<!--
status: SUPERSEDED
last_verified: 2026-07-03
-->
> **Archived (2026-08-15).** Historical "Babel Full" product-identity document. Its claim
> that `babel deep` is read-only does **not** describe the current runtime: `babel deep`
> is the live governed pipeline with Stage 4 executor mutation. The bounded, tested
> multi-agent capability that replaced the speculative Full manager/worker design is
> documented in [MULTI_AGENT_ORCHESTRATION.md](../../architecture/MULTI_AGENT_ORCHESTRATION.md)
> (experimental, non-normative). Runtime norms: [HARNESS_ARCHITECTURE_V1.md](../../architecture/HARNESS_ARCHITECTURE_V1.md).
>
> Superseded by:
> - [HARNESS_ARCHITECTURE_V1.md](../../architecture/HARNESS_ARCHITECTURE_V1.md)
> - [MULTI_AGENT_ORCHESTRATION.md](../../architecture/MULTI_AGENT_ORCHESTRATION.md)
> - [CLI_COMMAND_CONTRACT.md](../../CLI_COMMAND_CONTRACT.md)

Date: 2026-06-05 (refreshed 2026-06-29)

## Identity

Babel Full is an orchestration layer over **isolated Babel Lite sessions**. It is not a separate mutating execution engine. The recently added DAG workflow engine (`babel-cli/src/orchestrator/workflowEngine.ts`) provides a parallel dispatch substrate that may eventually replace the strictly linear 4-stage pipeline for parallelizable workflow stages.

```text
Babel Lite  = one safe agent session in one repo
Babel Full  = manager + reviewer + merger over many Lite sessions
```

Full coordinates sessions; Lite executes them. Each worker, reviewer, and manager role should eventually invoke the same `AgentSession` contract behind `babel "<task>"`, `babel plan`, and compatibility lanes.

## Current proof lane (shipped)

The current `babel full` / `babel deep` orchestration proof is **read-only**:

- risk-based route decision via `liteFullRouter`
- deterministic read-only Spark evidence under `runs/babel-full/<run-id>/spark/read-only/`
- hardened plan + QA review artifacts
- `mutation_subagents.enabled: false`

Entry:

```text
babel deep "<task>" [--agents off|read-only] [--json]
babel "<task>"   # may invoke read-only critique for complex plans/fixes; implementation risk may route to deep
```

## Spark read-only evidence (current)

Before any governed execution, Full writes deterministic Spark agent evidence:

| Agent id | Role | Reads | Purpose |
| --- | --- | --- | --- |
| `repo-cartographer` | repo cartographer | root files, top-level dirs, package metadata | Ground scope in repo layout |
| `risk-contract-reviewer` | risk/contract reviewer | route decision | Surface risk signals and route reason |
| `test-verifier-scout` | test/verifier scout | README, package.json, AGENTS/PROJECT files | Propose verification ladder |
| `implementation-plan-critic` | implementation-plan critic | synthesis only | Refuse mutating subagents until proof exists |

Each agent writes `runs/babel-full/<run-id>/spark/read-only/<agent-id>.json` with `mutation_allowed: false`.

## Artifact layout (current)

```text
runs/babel-full/<run-id>/
  route_decision.json
  full_result.json
  hardened_plan.md
  hardened_plan.json
  qa_review.json
  cost_ledger.json
  spark/
    read-only/
      repo-cartographer.json
      risk-contract-reviewer.json
      test-verifier-scout.json
      implementation-plan-critic.json
```

## Target manager loop (future, proof-gated)

```text
Manager Lite session
  -> task brief + risk contract
  -> worker Lite session A (isolated worktree/shadow root)
  -> worker Lite session B (isolated worktree/shadow root)
  -> reviewer Lite session (read-only diff audit)
  -> merger policy (disjoint scope, overlap refusal)
  -> verifier (per-worker + final)
  -> rollback evidence
```

### Role contracts (target)

| Role | AgentSession verbs | Mutation | Isolation |
| --- | --- | --- | --- |
| Manager | `plan`, `ask` | read-only | parent repo view |
| Worker | `fix`, `propose` | scoped writes | worktree or shadow root per worker |
| Reviewer | `review` | read-only | diff-only audit across worker outputs |
| Merger | policy gate | none directly | applies only disjoint, verifier-passing patches |
| Verifier | external checks | read-only | per-worker + final aggregate |

### Merger policy (target)

- Accept only patches with disjoint file scopes across workers.
- Refuse merge when overlap is detected unless explicit conflict-resolution evidence exists.
- Require per-worker verifier PASS before merge consideration.
- Emit merge report with accepted/rejected hunks and rationale.

### Rollback evidence (target)

Every mutating worker must leave:

- checkpoint id and restore command (`bl undo` or `babel checkpoint restore …`)
- filesystem-before snapshot
- `changes.diff` scoped to that worker
- verifier stdout/stderr logs
- terminal status summary with non-success on verifier failure

## Required evidence before mutating workers

Mutating Full worker claims require all of:

- isolated worktree or shadow-root execution per worker
- conflict-resolution evidence for overlapping writes
- per-worker verifier artifacts
- checkpoint + rollback proof for each worker
- hostile dirty-worktree recovery tests

Until that evidence exists, Full must remain read-only in product wording and production gates. `mutation_subagents.enabled` must stay `false`.

## Escalation rules

- `babel "<task>"` must preserve original intent before applying risk signals.
- Read-only default-path tasks such as audits, comparisons, diagnostics, recommendations, and no-write plans stay in read-only/report/plan lanes. They may still attach read-only critique evidence.
- Clear implementation default-path tasks may escalate to `babel deep` when risk signals fire; output must expose route metadata in JSON/artifacts.
- `--lite-only` must refuse Full-required work instead of silently widening scope.
- Full must never hide permission expansion.
- Escalated output and artifacts must include: `selected_lane`, `route_reason`, `complexity`, `risk_signals`, `model_tier_recommendation`, `full_babel_equivalent`, and intent metadata. Default human output should stay concise.

## Full/governance triggers

These signals are risk evidence, not automatic write permission:

- repo-wide / architecture / refactor / migration scope
- protected Babel control-plane files
- plugin, MCP, or public-export/gov surfaces
- repeated failures, recovery loops, rollback risk, or schema failure drift
- performance or security-sensitive phrasing

Escalate to Full/governed behavior when the user explicitly asks for Full/governed/agented execution, or when clear implementation intent appears with these risk signals. Keep read-only intent read-only.

## Relationship to babel run

| Surface | Audience | Mutation | Notes |
| --- | --- | --- | --- |
| `babel` / `babel plan` | daily work | implementation allowed only when intent and gates permit it | prefer this entry |
| `babel deep` | explicit Full/governed planning | read-only Spark + hardened plan today | current proof lane |
| `babel run` | advanced pipeline controls | governed executor | under `babel advanced`; explicit modes |

Use `babel "<task>"` for daily work. Use `babel plan` when the user wants to review and approve the plan before mutation. Use `babel deep` when the user explicitly wants heavier critique/refine/governed behavior. Use `babel run` only when explicit pipeline modes, audit streams, or tool/model overrides are required.

## Explicit backlog (blocked)

- mutating worker spawn with worktree isolation proof
- live subagent write evidence
- merger conflict-resolution harness
- hostile dirty-worktree recovery matrix for multi-worker runs
