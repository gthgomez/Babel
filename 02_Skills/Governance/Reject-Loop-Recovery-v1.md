<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Reject Loop Recovery Protocol (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_swe_frontend`, `domain_devops`
**Activation:** Load this skill when a REJECT payload is received from the QA Adversarial Reviewer.

---

## Purpose

After a QA REJECT, the most common failure mode is anchor bias: the SWE Agent edits the rejected
plan minimally, resubmits it, and receives the same rejection tags. The PROPOSED_FIX_STRATEGY field
exists specifically to break this loop — but only if the SWE Agent knows how to use it.

This skill defines the exact protocol for reading a REJECT payload and producing a revision that
addresses the root cause rather than patching the surface.

---

## Activation Condition

Load this skill only when ALL of the following are true:

1. The incoming payload contains `verdict: "REJECT"` from the QA Adversarial Reviewer.
2. A `FAILURES` list is present with at least one tagged item.
3. You are the SWE Agent preparing a revised plan.

Do NOT load this skill for a first-attempt plan (no prior REJECT in the current pipeline run).

---

## Step 1 — DISCARD THE REJECTED PLAN

Do not open the rejected plan. Do not edit it. Do not copy sections from it.

Start from the REJECT payload only.

**Why:** Every section you carry forward from the rejected plan carries the assumptions that caused
the rejection. The rejection tags are the correct starting point — not the plan text.

The only field from the rejected plan you may use is `plan_version` — so you can increment it.

---

## Step 2 — READ THE FAILURE TAGS, NOT THE PROSE

Locate the `FAILURES` list in the REJECT payload. Read each `[TAG]` and its condition statement.

**Do not read the prose explanation as a fix suggestion.** The tag is the data. The condition
statement tells you exactly what was not handled. Example:

```
[EVIDENCE-GATE]  gpc-signal/index.ts is not present in submission context.
```

This tells you: the file `gpc-signal/index.ts` must be read before any plan section is written.
It does not tell you what the fix is — because the QA reviewer does not know the fix. You do.

For each tag, map it to the action it requires:

| Tag Prefix | Required Action Before Rewriting |
|-----------|----------------------------------|
| `[EVIDENCE-GATE]` | Run Evidence Gathering Protocol (Step 1–3) for the named file/schema. |
| `[SFDIPOT-O]` | Run the Ops Observability Protocol (`skill_ops_observability`). Draft the full OPERATIONAL section — operation surface, logging strategy, and recovery paths — before resubmitting. If the rejected plan also contained retry-capable operations, also run `skill_idempotency` to produce the IDEMPOTENCY CONTRACT section. |
| `[NAMIT-N]` | Enumerate all null/undefined paths for the named operation. State each explicitly. |
| `[NAMIT-I]` | Identify every system boundary where input validation must occur. |
| `[NAMIT-T]` | Map every async operation and its timeout/error propagation path. |
| `[BCDP-*]` | Re-run BCDP from Step 1 for the named contract. |
| `[SECURITY-*]` | Re-read the affected code path with the named security category as the lens. |
| `[ROOT-CAUSE-MISSING]` | Do not write the plan until the root cause is identified. State it in KNOWN FACTS. |
| `[ROOT-CAUSE-SYMPTOM-FIX]` | Find what produces the symptom upstream. The fix must address that source. |
| `[ROOT-CAUSE-NO-PREVENTION]` | Add a structural prevention to VERIFICATION METHOD (test, constraint, schema). |
| `[INCOMPLETE_SUBMISSION]` | Re-read the six required plan sections. Add any that were absent. |

Complete every required action for every tag before writing a single line of the revised plan.

---

## Step 3 — EXECUTE PROPOSED_FIX_STRATEGY

Locate `PROPOSED_FIX_STRATEGY` in the REJECT payload. It names a dimension, not a fix.

Execute the named dimension as a literal pre-plan action:

- `"evidence"` → complete Evidence Gathering Protocol before writing KNOWN FACTS.
- `"null handling"` → enumerate every null path in the task's affected operations.
- `"BCDP"` → complete consumer identification and severity classification first.
- `"root cause"` → identify the upstream source of the failure before writing OBJECTIVE.
- `"operational coverage"` → draft the OPERATIONAL section before the MINIMAL ACTION SET.

**Do not skip this step** because you believe you already addressed it in the rejected plan.
The QA reviewer rejected the plan. By definition, you had not addressed it adequately.

---

## Step 4 — ANTI-ANCHOR CHECK

Before writing the revised plan, answer these three questions:

1. **What sections am I changing?** List them explicitly.
2. **Which tagged FAILURE does each change address?** Map change to tag.
3. **Are there any sections I am carrying forward unchanged?** If yes, state why no change was needed.

If you cannot map at least one change to each tagged FAILURE, you have not addressed the rejection.
Do not submit until you can.

---

## Step 5 — INCREMENT PLAN_VERSION

The revised plan header must increment `plan_version` before submission.

The QA Adversarial Reviewer automatically rejects any plan with an unchanged `plan_version`
with `[DUPLICATE_SUBMISSION]`. This is a mechanical check — the content is irrelevant if the
version does not increment.

---

## Step 6 — ESCALATION TRIGGER

If `plan_version` is reaching `v4` or higher, prepend this block to the revised plan:

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

Do not suppress this flag. Do not omit it because you believe the current revision will pass.
The flag is informational — the pipeline continues, but the human operator is notified.

---

## Hard Rules

1. Never submit a revised plan without incrementing `plan_version`.
2. Never resubmit a plan whose MINIMAL ACTION SET is identical to the rejected version.
3. Never map a `[SFDIPOT-O]` failure as addressed by adding a comment to a code step. Operational
   coverage means a declared logging strategy, error surface, and recovery path — not a comment.
4. Never suppress the escalation flag at v4+. Suppression defeats its purpose.
5. If the REJECT payload is malformed or missing required fields (no `FAILURES` list, no
   `PROPOSED_FIX_STRATEGY`), treat it as a pipeline error — output:
   `PIPELINE ERROR: REJECT payload is malformed. Cannot derive revision guidance. Human review required.`
   Do not attempt to revise the plan from an incomplete REJECT.
