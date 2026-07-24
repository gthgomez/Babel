<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Workflow Pattern: Human Gate (v1.0)

**Category:** Governance / Workflow Patterns
**Status:** Active — pre-audited to OLS-MCC v4.2 standards
**Pattern type:** Human-in-the-loop approval gate
**Composes with:** Wraps any other pattern (ReAct, Verification-Loop, Hierarchical-Delegation)

---

## Purpose

The Human Gate inserts a mandatory human approval checkpoint into an otherwise autonomous workflow. The agent pauses, presents its proposal or output, and awaits an explicit approve/reject/modify decision before proceeding. If the human is absent, a timeout triggers a pre-declared default action. This is the pattern behind deployment approvals, spend authorizations, irreversible action gates, and any boundary where autonomy must yield to human judgment.

---

## When to Use

**Use Human-Gate when:**
- The next action is irreversible (deploy to production, delete data, charge a customer).
- The cost of a wrong decision exceeds the cost of waiting for human review.
- The decision requires contextual knowledge the agent doesn't have (business priorities, user impact, legal judgment).
- The agent's confidence is below threshold and human validation is required before proceeding.
- The workflow crosses an autonomy boundary defined by the Autonomous State Machine.

**Do NOT use Human-Gate when:**
- The action is reversible and low-cost (just do it and report).
- The human is known to be absent and the timeout default action is well-defined (use Autonomous State Machine's Absent-User Protocol directly).
- The decision is purely technical and within the agent's verified competence.
- The gate would fire so frequently it becomes a bottleneck (reconsider the autonomy boundary).

---

## Workflow

```
┌──────────┐
│  PAUSE   │ ← Agent completes work up to the gate, prepares presentation
└────┬─────┘
     │
┌────▼─────┐
│ PRESENT  │ ← Present proposal/decision/output to human in scannable format
└────┬─────┘
     │
┌────▼──────────┐
│ AWAIT DECISION│ ← Wait for human response (with timeout)
└────┬──────────┘
     │
┌────▼─────┐
│ DECISION?│
└────┬─────┘
     │
  ┌──┼──────────────┐
  │  │              │
APPROVE         TIMEOUT
  │  │              │
  │  │         ┌────▼──────┐
  │  │         │DEFAULT ACT│ ← Pre-declared default: PROCEED or ABORT
  │  │         └────┬──────┘
  │  │              │
  │  │         ┌────▼──────┐
  │  │         │  RESUME   │
  │  │         └───────────┘
  │  │
  │  │  REJECT
  │  │    │
  │  │  ┌─▼──────────┐
  │  │  │REFINE/ABORT │ ← Human provides reason + what to change
  │  │  └────────────┘
  │  │
  │  │  MODIFY
  │  │    │
  │  └────┼──→ Apply modifications, re-PRESENT for re-approval
  │       │
  └───────┼──→ Proceed past gate
          │
```

### Phase Details

**PAUSE**
- Agent reaches the gate boundary. Stop all autonomous work.
- Prepare the presentation: what is being proposed, why, what happens if approved/rejected, blast radius, confidence.
- Output: Structured proposal (see Presentation Template below).

**PRESENT**
- Deliver the proposal to the human in the most appropriate channel (chat, notification, PR comment, Discord).
- Format for scannability: decision in one sentence, supporting evidence below, explicit approve/reject/modify options.
- Output: Presentation delivered + channel confirmed.

**AWAIT DECISION**
- Wait for human response. Do not proceed past the gate.
- Timeout clock starts. Duration depends on blast radius (see Blast Radius Timeout Table).
- During wait: agent may continue other non-gated work if isolated from the gated action.
- Output: Human response OR timeout trigger.

**DECISION OUTCOMES:**
- **APPROVE**: Agent proceeds past gate. Record approval with timestamp + approver identity.
- **REJECT**: Agent does NOT proceed. Record rejection reason. Option to refine and re-present (counts as new cycle) or abort the gated action entirely.
- **MODIFY**: Human provides specific changes. Agent applies changes and re-enters PAUSE → PRESENT for re-approval (increments the gate cycle counter).
- **TIMEOUT**: Human didn't respond within the blast-radius-appropriate window. Execute the pre-declared default action.

---

## Blast Radius Classification & Timeout

| Blast Radius | Examples | Timeout | Default Action |
|-------------|----------|---------|----------------|
| **LOW** | Cosmetic UI change, non-critical log message edit, documentation | 2 hours | PROCEED (reversible) |
| **MEDIUM** | Feature flag change, DB migration on staging, non-customer-facing API change | 8 hours | PROCEED (with rollback plan) |
| **HIGH** | Production deploy, payment flow change, authn/z change, data mutation, email to users | 24 hours | ABORT (irreversible or high-visibility) |
| **CRITICAL** | Credential rotation, PII/data deletion, compliance-affecting change, infra teardown | 48 hours | ABORT (always — no timeout override) |

**Round-up rule:** If uncertain between two classifications, choose the higher one.

---

## Presentation Template

Every Human-Gate PRESENT phase must include:

```
╔══ HUMAN GATE ═══════════════════════════════╗
║ Action: [One sentence — what will happen]   ║
║ Blast Radius: [LOW / MEDIUM / HIGH / CRITICAL] ║
║ Timeout: [duration] → Default: [PROCEED / ABORT] ║
║                                              ║
║ Context: [2-3 sentences — why, what led here]║
║ Evidence: [Key findings that support this]    ║
║ Risk: [What could go wrong + mitigation]      ║
║ Rollback: [How to undo if wrong]              ║
║                                              ║
║ Options:                                      ║
║   [✓] APPROVE — proceed as described         ║
║   [✗] REJECT — do not proceed (provide reason)║
║   [~] MODIFY — change [specific aspect]      ║
╚══════════════════════════════════════════════╝
```

---

## Stop Conditions

| Condition | Action | Priority |
|-----------|--------|----------|
| **Human APPROVE** | Proceed past gate. Record decision. | NORMAL |
| **Human REJECT** | Stop gated action. Record reason. | NORMAL |
| **Timeout + DEFAULT = PROCEED** (non-CRITICAL only) | Proceed with recorded timeout + blast radius justification. | HIGH |
| **Timeout + DEFAULT = ABORT** | Stop gated action. Notify human of abort reason. | HIGH |
| **Gate cycle limit reached** (3 MODIFY cycles) | Force APPROVE/REJECT binary — no more modifications. | MEDIUM |
| **External halt signal** | ABORT. Preserve gate state for resume. | HIGH |

---

## Failure Behavior

| Phase | Failure Mode | Behavior |
|-------|-------------|----------|
| PRESENT | Presentation channel unavailable (can't reach human) | Try alternative channels (backup notification). If all fail, escalate to Autonomous State Machine Absent-User Protocol. |
| AWAIT | Human partially responds (ambiguous) | Ask for clarification. Do NOT interpret ambiguity as approval. |
| AWAIT | Human requests more information before deciding | Provide requested info. Do NOT re-enter PRESENT — this is a pause extension, not a new cycle. |
| TIMEOUT | Default action was PROCEED but action fails | Record the gated decision as the root cause. The gate gave permission; the failure is in execution, not the gate. |
| TIMEOUT | Default action was ABORT but the work was time-sensitive | Flag as GATE_BLOCKER. The timeout was too long for the blast radius. Recommend shorter timeout or human escalation path. |

---

## Integration Points

- **With Autonomous State Machine:** Human-Gate implements the WAIT_FOR_APPROVAL state. The state machine's Absent-User Protocol defines the timeout routing table.
- **With ReAct / Verification-Loop / Hierarchical-Delegation:** Human-Gate wraps these patterns at approval boundaries. It is always the outermost pattern.
- **With Ops-Observability:** Every gate transition (PAUSE, PRESENT, APPROVE/REJECT/TIMEOUT) is an observable event. Use OBSERVE mode to track gate latency, timeout frequency, and human decision patterns.

---

**Design note:** Pre-audited to OLS-MCC v4.2 PRODUCTION standards. Includes blast-radius-gated timeout table, explicit presentation template, stop conditions, and integration with Autonomous State Machine.
