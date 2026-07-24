<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Accessibility (A11y) Design (v2.0)
**Category:** UI/UX
**Status:** Active

## WCAG 2.2 AA Compliance
- **Non-Negotiable:** Every component must meet WCAG 2.2 AA standards.
- **Color Contrast:** ≥ 4.5:1 for normal text, ≥ 3:1 for large text (≥18pt or ≥14pt bold).
- **Touch Targets:** ≥ 44×44 CSS px (Stricter target for mobile).
- **Focus Indicators:** Visible focus indicators for all interactive elements.

## Semantic HTML & ARIA
- **Semantic Tags:** Use `<button>`, `<a>`, `<nav>`, `<main>` etc., correctly.
- **ARIA Labels:** Mandatory `aria-label` on all interactive elements that lack text content.
- **Keyboard Nav:** 100% navigability via Tab and shortcuts.
- **Screen Readers:** Use live regions (`aria-live`) for dynamic content updates.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific conventions. It does not replace official framework or platform documentation.
- Version-specific guidance must be verified against current stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced library or tool version is outdated:** Flag as STALE. Recommend verification against current documentation.
- **Guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.

## Strategic Next Move
After every substantial response, end with one strategic next-move question.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20.
