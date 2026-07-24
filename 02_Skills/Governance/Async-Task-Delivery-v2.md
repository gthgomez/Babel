<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Async Task Delivery (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** v1.0 (compiled min only — this is the first full-source version)
**Pairs with:** `skill_autonomous_agent_state_machine` (REPORT state), `skill_json_output_contract` (webhook format), `skill_untrusted_input_guard` (injection defense), `ops-observability` (delivery tracing)
**Activation:** Load when the agent will deliver a task result to an external channel (Slack, Discord, webhook, WhatsApp) — especially in autonomous/unattended mode where the human reads the result hours later, possibly on a different device, without session context.

---

## Purpose

An async delivery is the only artifact the human sees from an autonomous run. If it's ambiguous, poorly structured, or buries the outcome, the human can't act on it — and may not even know whether the task succeeded. Every delivery must be self-contained: status first, evidence labeled, resume path explicit, confidence stated.

This skill enforces a structured delivery contract covering: result classification, confidence labeling, detail sections, PARTIAL/BLOCKED formats, and platform-specific formatting rules for Slack, Discord, WhatsApp, and webhook/JSON channels.

---

## Step 1 — CLASSIFY THE RESULT

### Status

| Status | Criteria |
|--------|----------|
| `SUCCESS` | All plan steps completed. Evidence gathered. Verification passed. |
| `PARTIAL` | Some steps completed, some did not. Partial output exists. |
| `BLOCKED` | Execution did not begin or was stopped by a HALT condition. |
| `WAIT` | Plan complete, waiting for approval. Used for hold messages. |

### Confidence

| Level | Criteria |
|-------|----------|
| `HIGH` | All claims are based on observed, verified facts from this session. |
| `MEDIUM` | One or more inferred facts or unverified assumptions inform the result. |
| `LOW` | Significant uncertainty — result may be incomplete or incorrect in material ways. |

**Rule:** If you find yourself writing a LOW confidence result with reassuring language — stop. Write what you know and what you don't. Padding LOW confidence with "should work" or "looks good" misleads the human.

---

## Step 2 — COMPOSE THE DELIVERY HEADER

```
STATUS: SUCCESS | PARTIAL | BLOCKED | WAIT
CONFIDENCE: HIGH | MEDIUM | LOW
SUMMARY: [1-2 sentences — what was done and what the outcome is]
```

This header must be the first thing in the message. Do not bury it after context or explanation. The human scanning 20 unread messages must see STATUS and CONFIDENCE before anything else.

---

## Step 3 — COMPOSE THE DETAIL SECTIONS

```
ACTIONS TAKEN:
- [each completed step, one bullet]
- (or "none" if BLOCKED before any action)

ISSUES:
- [problems encountered, with file/line/reason if applicable]
- (or "none" if SUCCESS with no issues)

NEXT STEPS:
- [what the human needs to do, approve, or decide]
- (or "none required" if SUCCESS and fully resolved)
```

**ACTIONS TAKEN:**
- List what was actually done, not what was planned.
- Do not claim a step was completed if you only planned it.
- If a step was partially completed, describe what was done and what was not.

**ISSUES:**
- Include every problem encountered, including minor ones.
- Do not omit issues because they "worked out in the end."
- For each issue, state: what it was, why it occurred, and whether it was resolved.

**NEXT STEPS:**
- List anything the human needs to do before the task is truly complete.
- If stopped mid-task, list exactly what needs to happen to resume.
- If awaiting approval (WAIT status), list what signal to send and by when.

---

## Step 4 — CONFIDENCE LABELING FOR INLINE CLAIMS

| Label | Meaning |
|--------|---------|
| `[observed]` | You read this in a file this session, or you executed this and saw the output. |
| `[inferred]` | Reasonable conclusion from observed facts, but not directly verified. |
| `[assumed]` | Required assumption; could not be verified from available context. |

**Rule:** If more than two `[assumed]` labels appear in a single delivery, downgrade confidence to MEDIUM. If more than five, downgrade to LOW. The labeling IS the confidence — don't claim HIGH with five assumptions.

---

## PARTIAL Result Format

```
PARTIAL COMPLETION:
- Completed: [steps done]
- Incomplete: [steps not done]
- Reason stopped: [why execution did not continue]
- State preserved: YES | NO — [if YES, describe what state was left and where]
- Resume path: [what the human or next run needs to do to complete the task]
```

Never deliver a PARTIAL result without a resume path. A partial task with no resume path is a dead end — the human has partial work and no way to finish it.

---

## BLOCKED Result Format

When STATUS is BLOCKED, the delivery is the halt report from `skill_autonomous_agent_state_machine`:

```
STATUS: BLOCKED
CONFIDENCE: N/A
SUMMARY: Task halted before execution. See details below.

HALT REASON: [one-line description]
STATE AT HALT: [PLAN | WAIT_FOR_APPROVAL | ACT]
TASK: [what was requested]
ATTEMPTED: [steps completed, or "none — halted before ACT"]
BLOCKER: [exact problem]
REQUIRED TO CONTINUE: [what the human must provide or confirm]
```

---

## Platform Formatting Rules

| Platform | Rules |
|----------|-------|
| **Slack** | No markdown tables. Use bullet lists. Header fields on separate lines. |
| **Discord** | No markdown tables. Use bullet lists. Wrap multi-links in `<>` to suppress embeds. |
| **WhatsApp** | No headers (`##`). Use **bold** for STATUS/CONFIDENCE labels. |
| **Webhook / JSON** | Emit as JSON using the field names above as keys. Follow `skill_json_output_contract`. |

---

## Hard Rules

1. Never omit STATUS and CONFIDENCE from any async delivery. A result without these is ambiguous.
2. Never write SUCCESS when any step was not completed. PARTIAL is not failure — it is accurate.
3. Never write HIGH confidence when more than two `[assumed]` labels appear.
4. Never pad a LOW confidence result with reassuring language. Write what you know and what you don't.
5. Never deliver a PARTIAL result without a resume path.
6. The header block is always first. Context, explanation, and prose come after — never before.
7. A BLOCKED delivery is not a failure of the agent — it is the agent doing its job. Treat BLOCKED as a successful safety outcome.
8. **New in v2.0:** Every delivery must include a correlation ID linking it to the run that produced it. This enables cross-referencing with OBSERVE mode traces and run artifacts.

---

## Boundaries — Do Not Overstep

- **This skill formats and delivers results — it does not plan, execute, or approve tasks.** The content of the delivery is produced by the pipeline stages and state machine. This skill governs how it's packaged for external consumption.
- **This skill does not validate the correctness of the result.** Confidence labeling reflects the agent's own assessment. The human is the final validator.
- **This skill does not handle retry, redelivery, or delivery confirmation.** If a delivery fails (network error, channel unavailable), the retry strategy is handled by the pipeline's recovery infrastructure, not this skill.
- **This skill does not replace platform-specific formatting libraries.** It provides baseline rules for text-only channels. Rich formatting (Slack blocks, Discord embeds) requires platform-specific tooling beyond this skill's scope.

---

## Failure Behavior of This Skill

- **Delivery channel is unavailable or misconfigured:** Log the delivery payload locally with timestamp. Flag as UNDELIVERED. Transition the state machine to HALT with reason `delivery_channel_unavailable`. Do not silently drop the result.
- **Result content is too long for the channel (exceeds message limit):** Truncate the ISSUES and ACTIONS TAKEN sections first. Preserve the header, SUMMARY, and NEXT STEPS. Append a truncation note: "[Full details in run artifacts: <run_id>]".
- **Result contains content that triggers platform filters (spam, abuse detection):** Strip the triggering content. Flag what was removed. Deliver the remainder. This is rare but can happen with log output containing flagged patterns.
- **Confidence classification is ambiguous (borderline HIGH/MEDIUM):** Downgrade to MEDIUM. Over-claiming confidence is worse than under-claiming. The human can always upgrade after review.
- **Self-test:** This skill should be tested by delivering a mock SUCCESS, PARTIAL, and BLOCKED result to each supported platform and verifying the header is first and the formatting rules are followed.

---

## Strategic Next Move

After every delivery, end with exactly one strategic next-move question: for SUCCESS, ask whether the result changes the next task; for PARTIAL, ask whether to resume or abandon; for BLOCKED, ask what the human needs to unblock; for WAIT, remind of the approval deadline.

---

## References

- `skill_autonomous_agent_state_machine` (`02_Skills/Governance/Autonomous-Agent-State-Machine-v2.md`) — governs the REPORT state that triggers this skill.
- `skill_json_output_contract` — for webhook/JSON delivery format compliance.
- `skill_untrusted_input_guard` — injection defense for any response the human sends back after reading the delivery.
- `ops-observability` (`02_Skills/Governance/Ops-Observability-v2.md`) OBSERVE mode — for tracing delivery events and capturing delivery latency/reliability.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening delivery templates against discovered formatting edge cases.

---

**Design note:** This v2.0 is the first full-source version of the async task delivery skill. It supersedes the compiled-min-only v1.0 and retrofits the 4-step delivery pipeline with OLS-MCC v4.2 compliance: explicit Boundaries, Failure Behavior (4 scenarios), Strategic Next Move discipline, correlation ID requirement, and handoff contracts to the state machine, JSON output contract, and OLS-MCC meta layer.
