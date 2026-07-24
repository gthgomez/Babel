<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Workflow Pattern: Hierarchical Delegation (v1.0)

**Category:** Governance / Workflow Patterns
**Status:** Active — pre-audited to OLS-MCC v4.2 standards
**Pattern type:** Parent agent → sub-agents → aggregate
**Composes with:** Verification-Loop (per sub-agent), Human-Gate (approval between phases)

---

## Purpose

Hierarchical Delegation decomposes a complex task into independent sub-tasks, dispatches each to a specialized sub-agent (or parallel sub-agent pool), then aggregates results. This is the pattern behind "divide and conquer" for agentic workflows. It is the foundation for multi-agent orchestration, parallel work distribution, and domain-specialist routing.

---

## When to Use

**Use Hierarchical Delegation when:**
- The task naturally decomposes into independent sub-tasks (no shared mutable state between sub-tasks).
- Different sub-tasks require different domain expertise or tool access.
- Sub-tasks can run in parallel (wall-clock speedup) or must run sequentially (dependency chain).
- The aggregation step requires synthesis, conflict resolution, or quality scoring.

**Do NOT use Hierarchical Delegation when:**
- Sub-tasks share mutable state and require coordination mid-execution (use a single agent with ReAct instead).
- The task is simple enough for one agent to complete in <3 steps (delegation overhead exceeds benefit).
- Sub-agents would all need the same context (just run one agent with full context — cheaper and faster).

---

## Workflow

```
┌─────────────┐
│ DECOMPOSE   │ ← Analyze task, identify sub-tasks, assign specialists
└──────┬──────┘
       │
       ├──→ [Sub-Task 1] ──→ [Sub-Agent A] ──→ result_1
       ├──→ [Sub-Task 2] ──→ [Sub-Agent B] ──→ result_2
       ├──→ [Sub-Task N] ──→ [Sub-Agent N] ──→ result_N
       │         (parallel or sequential per dependency graph)
       │
┌──────▼──────┐
│ AGGREGATE   │ ← Merge, deduplicate, score, synthesize
└──────┬──────┘
       │
┌──────▼──────┐
│  VERIFY     │ ← Cross-sub-task consistency check
└──────┬──────┘
       │
  ┌────▼────┐
  │  REPORT  │
  └─────────┘
```

### Phase Details

**DECOMPOSE**
- Break the task into N sub-tasks. Each sub-task must be:
  - Self-contained (can be completed with a bounded context).
  - Independently verifiable (has a clear success criterion).
  - Assigned to exactly one specialist role (domain, skill set, or tool profile).
- Declare the dependency graph (parallel, sequential, or DAG).
- Output: Sub-task manifest with assignments, context budget per sub-agent, and timeout per sub-agent.

**DISPATCH**
- For each sub-agent, compile a minimal context: task description + relevant domain rules + necessary file access.
- Launch sub-agents according to the dependency graph (parallel where independent, sequential where dependent).
- Monitor: track elapsed time, token usage, and completion status per sub-agent.
- Output: Raw results from each sub-agent.

**AGGREGATE**
- Merge results from all sub-agents.
- Deduplicate overlapping findings or recommendations.
- Resolve conflicts between sub-agent outputs (flag irresolvable conflicts for human review).
- Score results by confidence and evidence quality.
- Output: Unified result set + conflict log.

**VERIFY**
- Cross-sub-task consistency: do aggregated results form a coherent whole?
- Completeness: were all sub-tasks addressed?
- Quality: does the combined output meet the task's quality bar?
- Output: Verification verdict (PASS / REVISE / MISSING_PARTS).

---

## Stop Conditions

| Condition | Action | Priority |
|-----------|--------|----------|
| **All sub-agents returned** (success or failure) | Proceed to AGGREGATE | NORMAL |
| **Cumulative timeout reached** (sum of sub-agent budgets + aggregation budget) | Terminate in-flight sub-agents, aggregate partial results | HIGH |
| **Critical sub-agent failure** (sub-agent whose output blocks 2+ others in dependency graph) | Terminate dependent sub-agents, report partial results | HIGH |
| **Babel pipeline mode halt** (external halt signal, session end) | Terminate all sub-agents, preserve partial state | HIGH |
| **Cost ceiling reached** | Terminate in-flight, aggregate available results | MEDIUM |
| **Sub-agent hallucination detected** (fabricated sources, paths, or APIs) | Terminate that sub-agent, flag its output as UNRELIABLE, exclude from aggregate | CRITICAL |

---

## Sub-Agent Contract

Each sub-agent must receive and respect:

| Field | Description |
|-------|-------------|
| `task` | Exact sub-task description — scoped to one concrete deliverable |
| `context_budget` | Max tokens for sub-agent context (deducted from parent budget) |
| `timeout_ms` | Hard timeout — sub-agent MUST return or be killed at this boundary |
| `output_schema` | Expected return shape (if structured output is needed) |
| `tools` | Allowed tool set (may be a subset of parent's tools) |
| `stop_conditions` | Additional sub-agent-specific stop conditions |
| `depends_on` | Sub-agent IDs this agent waits for (sequential dependency) |

Sub-agent failure contract:
- TIMEOUT → return partial results + `status: TIMEOUT`.
- TOOL_ERROR → return error context + `status: ERROR` (do NOT retry without parent instruction).
- HALLUCINATION → parent detects and excludes; sub-agent cannot self-detect.

---

## Failure Behavior

| Phase | Failure Mode | Behavior |
|-------|-------------|----------|
| DECOMPOSE | Can't identify clean sub-task boundaries | Task is not decomposable. Fall back to single-agent ReAct or Verification-Loop. |
| DECOMPOSE | Sub-tasks identified but overlap significantly | Merge overlapping sub-tasks. Flag as "decomposition is approximate — expect some duplication." |
| DISPATCH | All sub-agents timeout | Escalate: timeouts were too aggressive OR sub-tasks were too large. Re-decompose with smaller sub-tasks. |
| AGGREGATE | Sub-agent results contradict each other | Flag conflict with both results + evidence. Do NOT silently pick one. If resolution is needed, escalate to Human-Gate or ols-compiler. |
| VERIFY | Aggregated output is incomplete | Identify which sub-task(s) are missing. Re-dispatch only those with refined task descriptions. |
| VERIFY | Output is complete but quality is LOW | Mark as LOW-CONFIDENCE with specific quality gaps. Do not silently pass. |

---

## Integration Points

- **With Parallel-Swarm-Governance:** When `pipeline_mode = "parallel_swarm"`, always include `skill_workspace_locking` and use this pattern for task distribution.
- **With Verification-Loop:** Each sub-agent can internally use Verification-Loop if its sub-task output must meet an evidence-gated quality bar.
- **With Human-Gate:** Insert Human-Gate between DECOMPOSE and DISPATCH (approve the sub-task plan) or between AGGREGATE and REPORT (approve the final output).
- **With Ops-Observability OBSERVE mode:** Trace each sub-agent activation, cost, and outcome. Aggregate into a single run observation.

---

**Design note:** Pre-audited to OLS-MCC v4.2 PRODUCTION standards. Includes explicit sub-agent contract, stop conditions, failure behavior per phase, and integration points.
