<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Workflow Pattern: ReAct (v1.0)

**Category:** Governance / Workflow Patterns
**Status:** Active — pre-audited to OLS-MCC v4.2 standards
**Pattern type:** Single-agent reasoning loop with observation feedback
**Composes with:** Verification-Loop (nested in Act phase), Human-Gate (wrapping)

---

## Purpose

ReAct (Reason → Act → Observe) is the standard agentic reasoning cycle. The agent reasons about the task, acts on its reasoning, observes the outcome, and feeds that observation back into the next reasoning step. This template codifies the pattern with explicit stop conditions, failure behavior per phase, and evidence requirements — preventing the three failure modes that make naive ReAct loops dangerous: infinite looping, unobserved drift, and silent convergence failure.

---

## When to Use

**Use ReAct when:**
- The task requires multiple steps with feedback between them.
- The agent doesn't know the full solution path upfront — it must discover it through interaction.
- Tool outputs or external state changes modify what the agent should do next.
- The task is exploration-heavy, debugging, or investigative.

**Do NOT use ReAct when:**
- The task is a single, well-understood step (direct execution is cheaper).
- The full solution path is known and doesn't require feedback (use a sequential plan).
- The task is purely read-only with no external state changes (Verification-Loop is better).

---

## Workflow

```
        ┌──────────┐
        │  REASON  │ ← Analyze task, plan next action
        └────┬─────┘
             │
        ┌────▼─────┐
        │   ACT    │ ← Execute action, call tools, write code
        └────┬─────┘
             │
        ┌────▼─────┐
        │ OBSERVE  │ ← Check results, detect drift, update state
        └────┬─────┘
             │
        ┌────▼─────┐
        │ CONVERGE?│ ← Have we reached a solution?
        └────┬─────┘
          N  │  Y
        ┌────▼──┐  └──→ REPORT
        │Reason │
        └───────┘
```

### Phase Details

**REASON**
- Analyze the current state, previous observations, and remaining task.
- Formulate a single concrete next action (not a plan — one step).
- Predict the expected outcome of the action.
- Output: Action description + expected outcome + confidence.

**ACT**
- Execute exactly the action from the REASON phase.
- Use tools available in the current execution context.
- Do not chain multiple actions — one action per ACT phase.
- Output: Raw result of the action (tool output, file change, query result).

**OBSERVE**
- Compare actual outcome to predicted outcome from REASON.
- Classify: MATCH (as predicted), PARTIAL (partially correct), DRIFT (unexpected), ERROR (action failed).
- Update state with observation.
- Output: Observation classification + updated state summary.

**CONVERGE?**
- Evaluate: has the task reached a satisfactory conclusion?
- Criteria: all sub-goals met OR remaining uncertainty is below threshold OR further iterations would be unproductive.
- YES → proceed to REPORT.
- NO → return to REASON with accumulated observations.

---

## Stop Conditions

ReAct MUST terminate when ANY of these conditions are met:

| Condition | Action | Priority |
|-----------|--------|----------|
| **Max iterations reached** (default: 10) | Terminate with partial results + "max iterations" marker | HIGH |
| **Convergence detected** (3 consecutive OBSERVE phases with improvement < threshold) | Terminate — further iterations unlikely to help | HIGH |
| **Budget exhausted** (token or dollar cost limit reached) | Terminate with current state + cost summary | MEDIUM |
| **Drift escalation** (3 consecutive DRIFT observations without correction) | Terminate — agent is compounding errors | HIGH |
| **ERROR cascade** (2 consecutive ERROR observations) | Terminate — tool or environment is broken, not the reasoning | HIGH |
| **Human interrupt** (external halt signal) | Terminate gracefully, preserve state for resume | HIGH |
| **Safety trigger** (injection detected, unauthorized action attempted) | Terminate immediately, preserve evidence | CRITICAL |

---

## Failure Behavior Per Phase

| Phase | Failure Mode | Behavior |
|-------|-------------|----------|
| REASON | Can't formulate a concrete action (too ambiguous) | Ask for clarification. If autonomous: choose the least-risky action with [INFERRED] label. |
| REASON | Predicted outcome is vague ("should work") | Reject the prediction. Require a testable expected outcome before proceeding to ACT. |
| ACT | Action fails (tool error, permission denied) | Record ERROR observation. Re-REASON with the error as input. Do NOT retry same action without modified approach. |
| ACT | Action succeeds but with unexpected side effects | Record DRIFT observation with specific delta. Flag for OBSERVE phase analysis. |
| OBSERVE | Can't determine whether outcome matches prediction | Classify as DRIFT with "unverifiable outcome" note. Prefer explicit uncertainty over false MATCH. |
| OBSERVE | Observation contradicts prior state assumption | Flag as STATE_DRIFT. Feed corrected state into next REASON. |
| CONVERGE? | Task nominally complete but quality uncertain | Mark as CONVERGED-LOW-CONFIDENCE. Proceed to REPORT with caveat. |

---

## Evidence Requirements

Each phase transition must produce evidence:

| Transition | Evidence |
|------------|----------|
| REASON → ACT | Action description + predicted outcome (written before acting) |
| ACT → OBSERVE | Tool output or file diff (raw, uninterpreted) |
| OBSERVE → CONVERGE? | Observation classification + evidence label ([OBSERVED], [INFERRED]) |
| Any → TERMINATE | Stop condition that triggered + current state snapshot |
| CONVERGE? → REPORT | Final state + iteration count + convergence rationale |

---

## Integration Points

- **With Autonomous State Machine:** ReAct maps to the PLAN → ACT → OBSERVE (implicit in ACT) → REPORT cycle. The state machine's HALT conditions apply additionally.
- **With Verification-Loop:** Nest Verification-Loop in the ACT phase when an action's output must meet an evidence-gated quality bar before the OBSERVE phase.
- **With Human-Gate:** Wrap the entire ReAct cycle in Human-Gate if any phase transition requires approval.
- **With Ops-Observability OBSERVE mode:** After the ReAct cycle completes, use OBSERVE mode to capture the full trace (iterations, cost, drift events).

---

**Design note:** This pattern is pre-audited to OLS-MCC v4.2 PRODUCTION standards and includes all required sections: Boundaries (When to Use / Do Not Use), Failure Behavior per phase, explicit Stop Conditions, Evidence Requirements, and Integration Points. It is designed to be composable with the other Workflow Pattern Library templates.
