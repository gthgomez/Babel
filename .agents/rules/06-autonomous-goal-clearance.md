<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Autonomous Execution & Goal Clearance Protocol

Read this rule when initiating coding, refactoring, audit, or system implementation tasks to maximize agent autonomy and eliminate unnecessary plan-approval stalls.

---

## 1. Goal Clearance Gates (G0–G3)

Before modifying code or executing commands, verify that all four pre-execution clearance gates pass:

- **G0 — Authority & Boundaries:** The requested work is strictly within the user's stated goal and does not require unauthorized credentials, destructive actions, or external coordination.
- **G1 — Goal Clarity:** Intended outcome, acceptance criteria, and constraints are sufficiently explicit that reasonable interpretations will not alter the result.
- **G2 — Context Readiness:** Fresh project instructions (`AGENTS.md`, `CLAUDE.md`, `PROJECT_CONTEXT.md`), active git branch state, and relevant prior plans (`implementation_plan.md`, `roadmap.md`) have been inspected.
- **G3 — Execution Readiness:** A feasible working plan, proportionate verification strategy (builds, automated tests, or visual checks), and recovery path are established.

---

## 2. Autonomous Execution Stance

- **If G0–G3 Pass:** **DO NOT** pause to present an implementation plan or ask for execution approval. Proceed directly to implementation, testing, and verification.
- **If G0–G3 Fail:** Resolve the gate failure autonomously using safe local inspection tools if possible. If genuinely blocked (e.g., missing credentials or ambiguous high-risk trade-off), ask **ONE** consolidated blocking question.
- **Plan Maintenance:** Maintain an internal working plan and update local plan artifacts as evidence changes during execution without stopping for re-approval.

---

## 3. Verification & Completion Clearance (G4 Gate)

Before presenting the final handoff, run **G4 Completion Clearance**:
1. Run proportionate verification (unit tests, type checks, build checks, or visual previews).
2. Confirm evidence satisfies all G1 acceptance criteria.
3. Verify that no unintended side effects or broken contracts were introduced.

---

## 4. Final Handoff Structure

Conclude every execution session with a concise, evidence-backed handoff covering:
1. **Outcome:** What was accomplished.
2. **Changed Surface:** List of modified/created files (`file:///absolute/path`).
3. **Verification Results:** Command outputs, test pass rates, or visual evidence.
4. **Remaining Limitations / Risks:** Any explicit unresolved items.
5. **Next Single Action:** The single highest-leverage next move, if applicable.
