<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Adaptive Layouts (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_jetpack_compose`, `skill_android_app_classification`
**Activation:** Load for Android UI tasks that affect screen shells, navigation layout,
responsive sizing, tablet support, foldables, list-detail screens, or any Compose screen that
must adapt beyond a phone portrait layout.

---

## Purpose

This skill prevents the "phone-only" trap: layouts that work on a narrow handset but waste space,
hide navigation, or become awkward on larger screens.

---

## Core Rules

1. Classify the layout by available width before choosing the shell.
2. Use compact / medium / expanded thinking, not one fixed phone layout.
3. Keep primary actions reachable in every size class.
4. Prefer list-detail, supporting-pane, or rail-based shells when the screen has enough width.
5. Preserve the app's existing navigation model unless the current layout clearly cannot scale.

---

## Decision Guide

- Use a bottom bar for compact-width phone shells.
- Use a navigation rail or split pane when width is medium or expanded.
- Use two-pane or list-detail layouts when the app mixes a collection with a detail editor.
- Keep form-heavy screens readable on tablets; avoid stretching one narrow column across the full width.
- Reflow content instead of scaling it awkwardly.

---

## Compose Checks

- Read `WindowSizeClass` or an equivalent width signal before choosing the top-level layout.
- Keep spacing and maximum content width intentional on large screens.
- Make sure dialogs, sheets, and forms still feel balanced on tablets.
- Do not introduce a large-screen layout that breaks the existing single-source state model.

---

## Hard Rules

1. Never freeze a phone layout as the only layout if the app clearly needs large-screen support.
2. Never let navigation collapse into tiny controls on expanded screens.
3. Never trade adaptive structure for cosmetic scaling.
4. Never change the app shell without checking whether the current state model can support it.
