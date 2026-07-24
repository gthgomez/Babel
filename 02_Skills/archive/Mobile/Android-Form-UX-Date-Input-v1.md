<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Form UX and Date Input (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_jetpack_compose`, `skill_android_state_management`, `skill_android_room`
**Activation:** Load for Android tasks that involve add/edit forms, dates, due dates, paydays,
recurrence, schedule fields, validation, or any screen where users must enter and save time-based
or money-related values.

---

## Purpose

This skill keeps Android forms honest. It prevents the common failures where the UI saves the
wrong default date, hides a real schedule field behind a recurrence label, or makes the user
type dates in a brittle text box when a picker would be clearer.

---

## Core Rules

1. Give the user an explicit control for every real schedule field.
2. Do not hardcode `LocalDate.now()` when the domain expects a chosen date.
3. Separate recurrence from the actual due/pay date when both matter.
4. Prefer Material 3 date pickers for date selection.
5. Keep validation visible: show what is invalid, what is required, and what will be saved.

---

## Form Design Checks

- If the user must choose when a bill is due, expose that field directly.
- If the user must choose when income is received, expose that field directly.
- If both a recurrence rule and a date exist, store and edit them separately.
- If the UI uses presets, show the preset as a shortcut, not as the only source of truth.
- Keep currency and date fields clear, compact, and editable without extra taps.

---

## Compose Checks

- Hoist form state into the ViewModel when it affects save behavior.
- Keep picker open/closed state local to the Composable.
- Feed chosen dates back into the domain model before saving.
- Do not hide save-time transformations inside the repository if the UI could have captured the
  real value directly.

---

## Hard Rules

1. Never save a date field from a form unless the user had a real chance to choose it.
2. Never replace schedule inputs with a generic frequency label alone.
3. Never collapse recurrence, due date, and next occurrence into one ambiguous field if the app
   needs all three.
4. Never leave validation invisible when the form determines persisted data.
