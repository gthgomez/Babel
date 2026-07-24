<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Reject Loop Recovery Protocol (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** v1.0 (compiled min only — this is the first full-source version)
**Pairs with:** `skill_ops_observability` (DESIGN mode), `skill_idempotency`, `skill_evidence_gathering`, `ols-compiler` (hardening), `skill-auditor` (loop audit)
**Activation:** Load when a REJECT payload is received from the QA Adversarial Reviewer — the plan was rejected and must be revised. Also load when analyzing repeated rejection patterns across runs to identify systemic plan-quality gaps.

---

## Purpose

A rejected plan is feedback, not failure. But the SWE agent's natural instinct is to read the QA reviewer's prose, make the suggested fix, and resubmit — which often addresses the symptom while leaving the root cause intact. This produces rejection loops: the same failure class reappearing across multiple revisions because the agent fixed the instance but not the pattern.

This skill enforces a structured recovery protocol: discard the rejected plan entirely, read failure TAGS (not prose), execute the prescribed fix strategy per tag, anti-anchor check the revised plan, and escalate at v4+ when autonomous resolution has demonstrably failed.

---

## Activation Condition

1. The incoming payload contains `verdict: "REJECT"` from the QA Adversarial Reviewer.
2. A `FAILURES` list is present with at least one tagged item.
3. You are the SWE Agent preparing a revised plan.

---

## Step 1 — DISCARD THE REJECTED PLAN

Do not edit the rejected plan. Start from a clean slate. The rejected plan has been anchored in your context — editing it preserves the anchor. Deletion breaks the anchor.

---

## Step 2 — READ THE FAILURE TAGS, NOT THE PROSE

Do not read the prose explanation as a fix suggestion. The tag is the data. The prose is the reviewer's rationale for the tag — informative but not prescriptive. Fix the condition the tag identifies, not the example the prose describes.

Example:
```
[EVIDENCE-GATE]  gpc-signal/index.ts is not present in submission context.
```
This tells you: the file `gpc-signal/index.ts` must be read before any plan section is written. Do not just add the file — run the Evidence Gathering Protocol so all missing context is identified.

### Failure Tag Reference

| Tag | Required Action |
|-----|----------------|
| `[EVIDENCE-GATE]` | Run Evidence Gathering Protocol (Steps 1–3) for the named file/schema. |
| `[SFDIPOT-O]` | Run Ops Observability Protocol (`skill_ops_observability` DESIGN mode). Draft the full OPERATIONAL section — operation surface, logging strategy, and recovery paths — before resubmitting. If the rejected plan contained retry-capable operations, also run `skill_idempotency` for the IDEMPOTENCY CONTRACT. |
| `[NAMIT-N]` | Enumerate all null/undefined paths for the named operation. State each explicitly. |
| `[NAMIT-I]` | Identify every system boundary where input validation must occur. |
| `[NAMIT-T]` | Map every async operation and its timeout/error propagation path. |
| `[BCDP-*]` | Re-run BCDP from Step 1 for the named contract. |
| `[SECURITY-*]` | Re-read the affected code path with the named security category as the lens. |
| `[ROOT-CAUSE-MISSING]` | Do not write the plan until the root cause is identified. State it in KNOWN FACTS. |
| `[ROOT-CAUSE-SYMPTOM-FIX]` | Find what produces the symptom upstream. The fix must address that source. |
| `[ROOT-CAUSE-NO-PREVENTION]` | Add a structural prevention to VERIFICATION METHOD (test, constraint, schema). |
| `[INCOMPLETE_SUBMISSION]` | Re-read the six required plan sections. Add any that were absent. |

Complete every required action for every tag before writing a single line of the revised plan. Tags are cumulative — if the rejection has three tags, all three must be resolved.

---

## Step 3 — EXECUTE PROPOSED_FIX_STRATEGY

The QA payload includes a `PROPOSED_FIX_STRATEGY` field:

| Strategy | Action |
|----------|--------|
| `"evidence"` | Complete Evidence Gathering Protocol before writing KNOWN FACTS. |
| `"null handling"` | Enumerate every null path in the task's affected operations. |
| `"BCDP"` | Complete consumer identification and severity classification first. |
| `"root cause"` | Identify the upstream source of the failure before writing OBJECTIVE. |
| `"operational coverage"` | Draft the OPERATIONAL section before the MINIMAL ACTION SET. |

Do not skip this step because you believe you already addressed it in the rejected plan. The rejection is evidence that you didn't.

---

## Step 4 — ANTI-ANCHOR CHECK

Before writing the revised plan, answer:
1. **What sections am I changing?** List them explicitly.
2. **Which tagged FAILURE does each change address?** Map change → tag.
3. **Are there any sections I am carrying forward unchanged?** If yes, state why no change was needed.

If any change doesn't map to a specific tag, it's scope creep — remove it.

---

## Step 5 — INCREMENT PLAN_VERSION

The revised plan header must increment `plan_version` before submission.

---

## Step 6 — ESCALATION TRIGGER

When the same FAILURE tag appears across 3+ revision cycles, or the plan reaches v4+:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION FLAG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Plan Revision:  v[n]
Persistent Failures:
  [List FAILURE tags that appeared in more than one prior rejection]
Recommended Action:  Human review before resubmission.
Reason:  Three or more revision cycles indicate the task scope or available
         context may be insufficient for autonomous resolution.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Hard Rules

1. Never submit a revised plan without incrementing `plan_version`.
2. Never resubmit a plan whose MINIMAL ACTION SET is identical to the rejected version.
3. Never map a `[SFDIPOT-O]` failure as addressed by adding a comment to a code step. Operational coverage means a declared logging strategy, error surface, and recovery path — not a comment.
4. Never suppress the escalation flag at v4+. Suppression defeats its purpose.
5. If the REJECT payload is malformed or missing required fields (no `FAILURES` list, no `PROPOSED_FIX_STRATEGY`), treat it as a pipeline error — output: `PIPELINE ERROR: REJECT payload is malformed. Cannot derive revision guidance. Human review required.`
6. **New in v2.0:** Every revision cycle must be logged as an observable event. Ops-Observability OBSERVE mode should capture failure tag frequency to identify systemic plan-quality gaps.
7. **New in v2.0:** If the same failure tag appears in 2+ consecutive runs across DIFFERENT tasks, escalate to skill-auditor — the skill producing plans with that failure class may have a structural gap.

---

## Boundaries — Do Not Overstep

- **This skill recovers from rejections — it does not prevent them.** Prevention lives in the plan authoring process (evidence gathering, NAMIT coverage, operational completeness). This skill handles the case where prevention failed.
- **This skill addresses the SWE Agent's revision process — it does not modify the QA Reviewer's criteria.** If rejections appear to be incorrect (false positives), that's a QA calibration issue, not a recovery issue.
- **This skill escalates at v4+ — it does not decide to abandon the task.** The escalation flag recommends human review. The human decides whether to continue, rescope, or abandon.

---

## Failure Behavior of This Skill

- **REJECT payload is malformed (missing FAILURES list or PROPOSED_FIX_STRATEGY):** Output PIPELINE ERROR. Do not attempt recovery from a malformed signal — that's guessing, not recovery.
- **Failure tag is unrecognized (new tag not in the reference table):** Treat as `[EVIDENCE-GATE]` — gather evidence about what the tag means before proceeding. If the tag remains unclear, escalate.
- **Multiple tags conflict (one says "add evidence," another implies "remove scope"):** Resolve in tag order. [EVIDENCE-GATE] always first (you can't resolve scope without evidence). [SFDIPOT-O] second. NAMIT tags third. If still conflicting after resolving individually, escalate.
- **Escalation flag fires but the human is absent (autonomous mode):** HALT the task. Do not suppress the flag in autonomous mode. An escalating rejection loop in unattended operation is a safety risk — stop, don't loop.
- **Self-test:** This protocol should be tested by running a plan through QA rejection with known failure tags and verifying the revised plan addresses each tag's required action, not just the prose suggestion.

---

## Strategic Next Move

After every revised plan submission, end with exactly one strategic next-move question: if this was the first revision, ask whether the anti-anchor check found any carried-forward sections; if v3+, ask whether the escalation flag should fire.

---

## References

- `skill_ops_observability` (`02_Skills/Governance/Ops-Observability-v2.md`) DESIGN mode — for resolving `[SFDIPOT-O]` tags.
- `skill_idempotency` (`02_Skills/Governance/Idempotency-Contract-v2.md`) — for resolving idempotency gaps surfaced in `[SFDIPOT-O]` rejections.
- `skill_evidence_gathering` — for resolving `[EVIDENCE-GATE]` tags.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening the recovery protocol if new failure tag classes emerge.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for auditing skills that produce plans with repeated failure tags across runs.
- `ops-observability` OBSERVE mode — for tracking failure tag frequency and revision cycle counts.

---

**Design note:** This v2.0 is the first full-source version of the reject loop recovery protocol. It preserves the v1.0 6-step recovery workflow and 11-tag failure reference table, and adds OLS-MCC v4.2 compliance: Boundaries, Failure Behavior (5 scenarios including malformed payload, unrecognized tags, conflicting tags, autonomous escalation), Strategic Next Move, cross-run failure tag tracking, and handoff to the full meta-tool ecosystem.
