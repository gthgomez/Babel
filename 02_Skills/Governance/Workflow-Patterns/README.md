<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Verified Workflow Pattern Library

**Status:** Active | **Layer:** `02_Skills/Governance/Workflow-Patterns/`
**Governed by:** OLS-MCC v4.2 standards. Each pattern is pre-audited and includes stop conditions, failure behavior, and evidence requirements.

## Purpose

These are composable, pre-audited workflow templates for agentic and multi-agent tasks. They encode proven patterns with explicit stop conditions — preventing the three most common production agent failures: infinite loops, runaway delegation, and silent timeouts.

Each pattern is a *template*, not a pipeline config. Use them when designing agent behavior, composing pipeline stages, or choosing an execution strategy for a task.

## Decision Tree

```
Task received
  │
  ├─ Single clear step, no ambiguity?
  │   └─ No pattern needed. Direct execution.
  │
  ├─ Multiple steps with feedback between them?
  │   ├─ Steps build on each other, need verification?
  │   │   └─ Use: Verification-Loop-v1
  │   └─ Steps are independent, can run in parallel?
  │       └─ Use: Hierarchical-Delegation-v1
  │
  ├─ Agent needs to observe results and adjust?
  │   └─ Use: ReAct-v1
  │
  ├─ Step requires human judgment or approval?
  │   └─ Use: Human-Gate-v1
  │
  └─ Multiple patterns compose?
      └─ Nest them: e.g., Human-Gate wrapping Verification-Loop
```

## Pattern Index

| Pattern | File | When | Key Stop Condition |
|---------|------|------|--------------------|
| **ReAct** | `ReAct-v1.md` | Agent needs reasoning-observation feedback loop | Max iterations reached without convergence |
| **Hierarchical Delegation** | `Hierarchical-Delegation-v1.md` | Task decomposes into independent sub-tasks | All sub-agents returned OR cumulative timeout |
| **Verification Loop** | `Verification-Loop-v1.md` | Output must meet evidence-gated quality bar | Max loops reached OR quality threshold met |
| **Human Gate** | `Human-Gate-v1.md` | Decision requires human approval before proceeding | Timeout with default action OR explicit approve/reject |

## Integration with Babel Pipeline Modes

| Pipeline Mode | Recommended Pattern |
|---------------|---------------------|
| `direct` | No pattern — one-shot execution |
| `verified` | Verification-Loop (default) or ReAct |
| `autonomous` | ReAct + Hierarchical-Delegation (with Autonomous State Machine) |
| `manual` | Human-Gate at each approval boundary |
| `parallel_swarm` | Hierarchical-Delegation (with Workspace-Locking) |

## Pattern Composition Rules

1. **Human-Gate always wraps.** If human approval is needed at any point, the Human-Gate is the outermost pattern.
2. **Verification-Loop can nest inside ReAct.** Use ReAct for high-level reasoning, Verification-Loop for evidence-gated refinement of each action.
3. **Hierarchical-Delegation is parallel-safe.** Sub-agents are isolated by design. Use Workspace-Locking if they share mutable state.
4. **Stop conditions compose by taking the strictest.** If ReAct (max 10 iterations) wraps Verification-Loop (max 3 loops), each ReAct iteration incurs up to 3 verification loops — total cap is 10 * 3 = 30 verification passes.
5. **Timeout composes by summing at each level.** If ReAct has a 5-minute timeout and delegates to sub-agents with 2-minute timeouts, the ReAct timeout governs the full cycle including all sub-agent work.
