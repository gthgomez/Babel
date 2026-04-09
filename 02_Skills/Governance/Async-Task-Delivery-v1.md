<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Async Task Delivery (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `skill_autonomous_agent_state_machine`, `skill_json_output_contract`
**Activation:** Load when the agent will deliver a task result to an external channel (Slack,
Discord, webhook, etc.) without the human being interactively present. Also load for any
unattended run where the result is the primary record of what happened.

---

## Purpose

When a human is present, they can ask follow-up questions to resolve ambiguity in a result.
When a result is delivered asynchronously — to Slack while the user is away, to a channel log,
to a webhook — the result must be self-contained. The human reads it hours later, possibly on
a phone, possibly mid-context-switch.

An async result that says "Done! Everything looks good" when it is actually PARTIAL is a silent
failure. An async result that buries a MEDIUM-confidence guess in three paragraphs of confident
prose is a trust erosion event.

This skill enforces a structured delivery format that makes status, confidence, and blockers
immediately visible — before any prose, before any details.

This skill governs the REPORT state of `skill_autonomous_agent_state_machine`. It does not
replace `skill_json_output_contract` for pipeline-internal JSON — it applies to human-facing
async delivery to messaging surfaces.

---

## Step 1 — CLASSIFY THE RESULT

Before composing the delivery, classify the result outcome:

| Status | Meaning |
|--------|---------|
| `SUCCESS` | All plan steps completed. Evidence gathered. Verification passed. |
| `PARTIAL` | Some steps completed, some did not. Partial output exists. |
| `BLOCKED` | Execution did not begin or was stopped by a HALT condition. |
| `WAIT` | Plan complete, waiting for approval. Used for hold messages. |

And classify confidence in the result:

| Confidence | Meaning |
|------------|---------|
| `HIGH` | All claims are based on observed, verified facts from this session. |
| `MEDIUM` | One or more inferred facts or unverified assumptions inform the result. |
| `LOW` | Significant uncertainty — result may be incomplete or incorrect in material ways. |

**Rule:** If you find yourself writing a LOW confidence result with reassuring language — stop.
Uncertainty is information. The human needs to see it, not have it softened away.

---

## Step 2 — COMPOSE THE DELIVERY HEADER

Every async delivery begins with this header block, before any prose or detail:

```
STATUS: SUCCESS | PARTIAL | BLOCKED | WAIT
CONFIDENCE: HIGH | MEDIUM | LOW
SUMMARY: [1-2 sentences — what was done and what the outcome is]
```

This header must be the first thing in the message. Do not bury it after context or explanation.

---

## Step 3 — COMPOSE THE DETAIL SECTIONS

After the header, include only the sections that are non-empty:

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

**Rules for each section:**

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
- If you stopped mid-task, list exactly what needs to happen to resume.
- If you are awaiting approval (WAIT status), list what signal to send and by when.

---

## Step 4 — CONFIDENCE LABELING FOR INLINE CLAIMS

Within the detail sections, label any claim that is not directly observed:

- `[observed]` — you read this in a file this session, or you executed this and saw the output
- `[inferred]` — reasonable conclusion from observed facts, but not directly verified
- `[assumed]` — required assumption; could not be verified from available context

**Rule:** If more than two `[assumed]` labels appear in a single delivery, downgrade confidence
to LOW regardless of the header classification. An output built on multiple assumptions is not
a HIGH confidence result.

---

## PARTIAL result format

When STATUS is PARTIAL, add a PARTIAL COMPLETION section after the detail sections:

```
PARTIAL COMPLETION:
- Completed: [steps done]
- Incomplete: [steps not done]
- Reason stopped: [why execution did not continue]
- State preserved: YES | NO — [if YES, describe what state was left and where]
- Resume path: [what the human or next run needs to do to complete the task]
```

Never deliver a PARTIAL result without a resume path. A partial task with no resume path is
abandoned work, not partial work.

---

## BLOCKED result format

When STATUS is BLOCKED, the delivery is the halt report from `skill_autonomous_agent_state_machine`
formatted for the messaging surface:

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

## Platform formatting rules

Adapt format to the delivery surface:

| Surface | Rule |
|---------|------|
| Slack | No markdown tables. Use bullet lists. Header fields on separate lines. |
| Discord | No markdown tables. Use bullet lists. Wrap multi-links in `<>` to suppress embeds. |
| WhatsApp | No headers (`##`). Use **bold** for STATUS/CONFIDENCE labels. |
| Webhook / structured log | Emit as JSON using the field names above as keys. Follow `skill_json_output_contract`. |

---

## Hard Rules

1. Never omit STATUS and CONFIDENCE from any async delivery. A result without these is ambiguous.
2. Never write SUCCESS when any step was not completed. PARTIAL is not failure — it is accurate.
3. Never write HIGH confidence when any `[assumed]` label appears more than once.
4. Never pad a LOW confidence result with reassuring language. Write what you know and what you don't.
5. Never deliver a PARTIAL result without a resume path.
6. The header block is always first. Context, explanation, and prose come after — never before.
7. A BLOCKED delivery is not a failure of the agent — it is the agent doing its job. Treat BLOCKED
   as a first-class result, not an embarrassing edge case to minimize.
