<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Android UI Audit Review (v2.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_jetpack_compose`
**Activation:** Load for audit, critique, evaluation, or prioritized UI improvement plans. Do not load for direct implementation.

**Supersedes:** v1 archived at `archive/02_Skills/Mobile/Android-UI-Audit-Review-v1.md` (2026-05-21).

## Purpose

Deliver grounded, evidence-based UI reviews without inventing files or collapsing audit into code changes.

## Grounding Requirements

1. List exact files reviewed with paths from workspace inventory.
2. Evidence type: `code` (file:line) or `screenshot`. Do not cite UI not found.
3. Confidence levels:
   - High: code + screenshot match
   - Medium: code only
   - Low: inferred from neighboring files

## Deliverable Shape

1. **Grounded files reviewed**: [...]
2. **Strengths [Confidence]**: [...]
3. **Weaknesses [Confidence]**: [...]
4. **Suggested changes**: tied to file:line or screenshot region, with effort S/M/L
5. **Prioritized plan**: required fixes first, then improvements, then optional polish

## Review Axes Checklist

- Screen-flow clarity and primary action emphasis
- State coverage: loading, empty, error, success, disabled, permission-denied
- Hierarchy, spacing, density, max content width on expanded screens
- Accessibility: touch target >=48dp, contentDescription on icons, contrast risk, focus order
- Consistency across size classes
- Adaptive behavior: compact vs medium vs expanded

## Recommendation Discipline

- Tie every major recommendation to real screen, state, or file.
- Separate required fixes from optional polish.
- State what must remain unchanged.

## Hard Rules

1. Never invent Android UI filenames, screens, or flows.
2. Never treat evidence gathering as completed audit.
3. Never jump to code writing before findings are delivered.
4. Never assign High confidence without code or screenshot evidence.
