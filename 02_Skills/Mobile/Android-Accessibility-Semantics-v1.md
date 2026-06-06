<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Accessibility Semantics (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_jetpack_compose`, `skill_android_ui_audit_review`
**Activation:** Load for Android UI tasks that touch accessibility, TalkBack, semantics, labels,
icon-only controls, focus order, touch targets, contrast, or any Compose screen where the user
must perceive and operate controls reliably.

---

## Purpose

This skill prevents the common accessibility regressions that make Android screens look fine but
fail in practice: missing labels, tiny tap targets, broken focus order, and color-only status cues.

---

## Core Rules

1. Give every non-text control a meaningful `contentDescription` or explicit semantics label.
2. Keep interactive targets at least `48dp`.
3. Do not rely on color alone to communicate meaning, state, or validation.
4. Keep focus order aligned with the visual flow of the screen.
5. Prefer one clear label per field, button, or toggle. Avoid nested or duplicate announcements.

---

## Compose Checks

- Use `Modifier.semantics {}` when the default node label is not enough.
- Use `clearAndSetSemantics` only when the child nodes would confuse assistive tech.
- Mark decorative icons as decorative; do not announce them.
- If a control is icon-only, give the button itself a label.
- If a screen has error or success text, make the message readable without relying on color.

---

## Review Discipline

When auditing a screen, check:

- screen title and heading clarity
- field labels and helper text
- icon-only buttons
- error states and empty states
- focus movement through the form
- spacing and tap-size risk

If the task is an implementation request, fix the lowest-effort accessibility gaps first:
labels, semantics, touch targets, then focus order and validation copy.

---

## Hard Rules

1. Never ship an icon-only action without an accessible label.
2. Never approve a form with missing field labels or ambiguous helper text.
3. Never treat visual polish as accessibility if semantics are absent.
4. Never shrink touch targets below 48dp to fit more content.
