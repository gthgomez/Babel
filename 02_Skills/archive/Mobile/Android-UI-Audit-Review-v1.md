<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Android UI Audit Review (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_jetpack_compose`, `task_overlay_ai_android_development`

**Activation:** Load for Android tasks that ask to audit, review, critique, evaluate, analyze, or
suggest UI / UX changes for Compose screens. Especially load when the task requests findings,
recommended changes, or a prioritized UI improvement plan rather than direct implementation.

---

## Purpose

This skill prevents three common wrong paths in Android UI review tasks:

1. Inventing screen/file names before grounding on the real app structure
2. Returning an evidence request instead of the requested UI critique deliverable
3. Jumping to implementation steps before documenting findings and recommended changes

This file is for **evaluative UI work**. It does not replace `skill_jetpack_compose` for code
changes. It ensures the review is grounded and delivered in the requested shape first.

---

## Step 1 — GROUND THE REAL UI SURFACE

Before proposing changes, anchor the review to the actual app UI inventory.

Minimum files to inspect when present:

- app entry / navigation shell
- screen composables
- UI state model
- ViewModel that drives the screens
- theme / design-token files if visual recommendations are requested

For `example_mobile_suite`, prefer the app-local `ui/` package first. Do not invent filenames from
generic Compose examples.

**Rule:** If a screen name or file path was not found in the grounded inventory, do not cite it as
an existing implementation surface.

---

## Step 2 — STAY IN REVIEW MODE UNTIL THE DELIVERABLE EXISTS

When the user asks for an audit/review/critique/plan, the output is incomplete if it stops at
"read these files first."

Unless the user explicitly asked for evidence gathering only, produce a finished review deliverable
after grounding. Evidence gathering is an input, not the final answer.

**Do not convert this task into implementation by default.**

---

## Step 3 — USE THE REQUIRED DELIVERABLE SHAPE

A strong Android UI audit should usually contain these sections:

1. **Current strengths** — what already works well and should be preserved
2. **Current weaknesses** — concrete UX, clarity, hierarchy, spacing, accessibility, or flow issues
3. **Suggested changes** — specific improvements tied to real files/screens
4. **Prioritized plan** — ordered next steps with highest-value changes first

If the user requested only some of these, tailor the output, but do not collapse a UI audit into
a raw file-reading checklist.

---

## Step 4 — REVIEW AXES

Evaluate only what is supported by the evidence in context. Typical axes:

- screen-flow clarity
- primary action emphasis
- state clarity (loading, empty, error, success)
- copy quality and affordance clarity
- hierarchy, spacing, density, and visual rhythm
- accessibility basics (contrast risk, touch target risk, missing labels)
- consistency across screens and states

For Compose apps, prefer observations tied to the current state model and screen transitions rather
than generic visual advice.

---

## Step 5 — RECOMMENDATION DISCIPLINE

Every suggested change should be:

- tied to a real screen or file
- justified by a user-facing problem
- scoped as `low`, `medium`, or `high` effort when possible
- clearly separated from optional polish

If recommending a structural UI change, state what should remain unchanged.

---

## Output Pattern

Use this compact structure when the task asks for an audit plus plan:

```text
UI AUDIT

Grounded files reviewed:
- [...]

Strengths:
- [...]

Weaknesses:
- [...]

Suggested changes:
- [...]

Prioritized plan:
1. [...]
2. [...]
3. [...]
```

If evidence is missing, say exactly what is missing and why that blocks confidence. Do not bluff.

---

## Hard Rules

1. Never invent Android UI filenames, screens, or flows that were not grounded in the actual app.
2. Never treat an evidence-only reading list as a completed UI audit unless the user explicitly
   asked only for evidence gathering.
3. Never jump from "audit the UI" straight into code-writing steps without first delivering
   findings and suggested changes.
4. Tie every major recommendation to a real screen, state, or file already in context.
