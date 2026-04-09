<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Security Release Gate (v1.0)
**Category:** Governance
**Status:** Active
**Pairs with:** `skill_evidence_gathering`, `skill_compliance_evidence_audit`, `skill_supabase_rls_drift_audit`, `skill_session_model_reality_audit`
**Activation:** Load when deciding whether a system is safe to ship after security work. Typical triggers: “can we launch now?”, “production safe?”, “final security gate”, “release verdict”, “ship / do not ship”, or “turn this audit into a go-live gate”.

---

## Purpose

Use this skill to turn scattered security findings into a formal release decision with proof requirements.

The goal is not to restate the audit.

The goal is to answer:

1. What must be fixed before launch?
2. What can be accepted with caveats?
3. What evidence proves the current verdict?

---

## Step 1 — BUILD THE GATE TRACKS

Use tracks that reflect real launch risk. Typical tracks:

1. auth and session integrity
2. data-plane exposure and authorization
3. secrets and configuration
4. runtime and dependency posture
5. exploit validation and regression checks
6. documentation and claim honesty

Each track must have:

1. pass criteria
2. hard fail conditions
3. evidence source

---

## Step 2 — MAP FINDINGS TO GATE SEVERITY

Classify each finding as:

1. `launch_blocker`
2. `must_fix_before_scale`
3. `documented_residual_risk`
4. `not_verified`

Hard rule:

Anything that exposes customer data, breaks core auth security assumptions, or contradicts public security claims is a launch blocker until resolved or the claim is removed.

---

## Step 3 — REQUIRE REAL EVIDENCE

Acceptable evidence:

1. exact file/function references
2. migration names
3. local verification commands
4. remote verification commands
5. direct observed behavior
6. logs or query outputs

Do not accept:

1. “should be fixed now”
2. “probably handled by provider”
3. “tests passed” without covering the actual exploit path

---

## Step 4 — ISSUE THE VERDICT

Use exactly one:

1. `GREEN`
2. `YELLOW`
3. `RED`

Interpretation:

1. `GREEN` — production-safe for intended launch posture
2. `YELLOW` — needs fixes before scale or narrower public claims
3. `RED` — unsafe to deploy publicly

If the system is only safe for a narrower rollout, say so explicitly.

---

## Step 5 — DEFINE THE NEXT ACTION

A release gate is not finished until it tells the team what to do next:

1. immediate blockers
2. exact verification to rerun after fixes
3. who owns the next decision artifact

---

## Output Contract

Summarize with:

1. `Current verdict`
2. `Blocking findings`
3. `Residual accepted risks`
4. `Required evidence still missing`
5. `Next gate after remediation`

---

## Hard Rules

1. Never issue `GREEN` if a critical exploit path is only assumed fixed.
2. Never collapse `NOT VERIFIED` into `implemented`.
3. Never let marketing/security claims outrun real enforcement.
4. A launch gate must be reproducible by another reviewer from repo artifacts and commands.
5. Prefer a narrower honest launch verdict over a broader unsafe one.
