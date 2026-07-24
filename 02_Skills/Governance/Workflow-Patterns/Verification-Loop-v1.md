<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Workflow Pattern: Verification Loop (v1.0)

**Category:** Governance / Workflow Patterns
**Status:** Active — pre-audited to OLS-MCC v4.2 standards
**Pattern type:** Evidence-gated iterative refinement
**Composes with:** ReAct (nested in Act phase), Hierarchical-Delegation (per sub-agent), Human-Gate (wrapping)

---

## Purpose

The Verification Loop is an evidence-gated iterative refinement cycle: produce output, verify it against a quality contract, refine based on gaps, re-verify. It converges when the output meets the contract or when further iteration is unproductive. This is the pattern behind Babel's SWE-QA loop, compliance audits, and any workflow where "good enough" must be proven, not assumed.

---

## When to Use

**Use Verification-Loop when:**
- Output quality must meet explicit, testable criteria (correctness, compliance, completeness).
- The first attempt is likely imperfect and will benefit from structured feedback.
- The cost of a bad output exceeds the cost of verification iterations.
- Evidence of quality is required downstream (compliance, audit, review).

**Do NOT use Verification-Loop when:**
- The quality criteria are subjective or can't be verified programmatically (use Human-Gate).
- The output is trivial and first-attempt success is near-certain (direct execution is cheaper).
- The verification itself is more expensive than accepting a slightly imperfect output.

---

## Workflow

```
┌──────────┐
│  PRODUCE │ ← Generate initial output (plan, code, config, report)
└────┬─────┘
     │
┌────▼─────┐
│  VERIFY  │ ← Check output against quality contract
└────┬─────┘
     │
┌────▼─────┐
│  PASS?   │
└────┬─────┘
  N  │  Y
┌────▼──┐  └──→ REPORT (with verification evidence)
│REFINE │
└────┬──┘
     │
     └──→ PRODUCE (with refinement context)
```

### Phase Details

**PRODUCE**
- Generate output based on task requirements and any prior refinement feedback.
- Output must be concrete and testable (code, structured plan, config, data, report).
- First iteration: full output. Subsequent iterations: targeted fixes to issues identified in VERIFY.
- Output: The artifact under verification.

**VERIFY**
- Check the output against the quality contract. The contract must specify:
  - Correctness criteria (does it do what was asked?).
  - Completeness criteria (are all requirements addressed?).
  - Safety criteria (does it introduce new risks?).
  - Format/schema criteria (does it match the expected output shape?).
- Classify each criterion: MET, PARTIAL, UNMET.
- Output: Verification report with per-criterion verdict + evidence.

**PASS?**
- All criteria MET → PASS. Proceed to REPORT.
- Any criteria UNMET → REFINE (unless max loops reached).
- Only PARTIAL criteria, no UNMET → REFINE if improvement is likely; PASS-with-caveats if loop budget is exhausted.
- Output: PASS / REFINE decision + rationale.

**REFINE**
- Address specific UNMET and PARTIAL criteria from the verification report.
- Do NOT rewrite working parts — targeted fixes only.
- Record what changed and why.
- Output: Modified artifact + change log.

---

## Stop Conditions

| Condition | Action | Priority |
|-----------|--------|----------|
| **All criteria MET** | PASS. Proceed to REPORT. | NORMAL |
| **Max loops reached** (default: 3 for STANDARD, 5 for DEEP/PRODUCTION) | PASS-WITH-CAVEATS. List unmet criteria and accept-risk rationale. | HIGH |
| **No improvement between loops** (same UNMET criteria, no progress) | TERMINATE. Further iteration is unproductive. Flag root cause. | HIGH |
| **Regression detected** (previously MET criteria now UNMET) | TERMINATE. Refinement is breaking things. Roll back to last PASS iteration. | CRITICAL |
| **Budget exhausted** | TERMINATE with partial results + unmet criteria list. | MEDIUM |
| **Verification contract is flawed** (criteria are impossible, contradictory, or untestable) | TERMINATE. Fix the contract first, then re-run. | CRITICAL |

---

## Quality Contract Template

Every Verification-Loop instance must start with an explicit quality contract:

```yaml
quality_contract:
  correctness:
    - criterion: "<testable statement>"
      verify_by: "<how to check — test, inspection, comparison>"
  completeness:
    - criterion: "<testable statement>"
      verify_by: "<how to check>"
  safety:
    - criterion: "<testable statement>"
      verify_by: "<how to check>"
  format:
    - criterion: "<testable statement>"
      verify_by: "<how to check>"
  max_loops: 3
  convergence_threshold: "All criteria MET OR ≤1 PARTIAL with documented accept-risk"
```

---

## Failure Behavior

| Phase | Failure Mode | Behavior |
|-------|-------------|----------|
| PRODUCE | Output is empty or malformed | Flag as UNMET-CORRECTNESS. Do not proceed to VERIFY — fix PRODUCE first. |
| VERIFY | Can't evaluate a criterion (untestable) | Mark as UNVERIFIABLE. Treat as PARTIAL (not UNMET) — can't fail what you can't test. |
| VERIFY | Verification is more expensive than production | Flag as ARCHITECTURE_GAP. Accept the output at current quality if the cost differential is extreme. |
| REFINE | Fix introduces a new issue (regression) | Roll back. Flag as REGRESSION. Record what the fix attempted and why it regressed. |
| REFINE | Change is cosmetic, doesn't address the UNMET criterion | Reject the refinement. Require substantive change tied to a specific criterion. |

---

## Integration Points

- **With Babel SWE-QA pipeline:** The built-in SWE-QA loop is a Verification-Loop instance. This template generalizes it beyond code review to any output type.
- **With ReAct:** Nest Verification-Loop in the ACT phase when each ReAct action must produce verified output before the OBSERVE phase.
- **With Human-Gate:** Use Human-Gate as the VERIFY phase when criteria require human judgment (subjective quality, design decisions).
- **With Ops-Observability DESIGN mode:** Use DESIGN mode to define the operational contract that the VERIFY phase checks against for infrastructure tasks.

---

**Design note:** Pre-audited to OLS-MCC v4.2 PRODUCTION standards. Includes explicit quality contract template, stop conditions with regression detection, and failure behavior per phase.
