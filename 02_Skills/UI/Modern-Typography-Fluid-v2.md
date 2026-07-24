<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Modern Typography & Fluid Layout (v2.0)

## Purpose
Guidelines for premium typography and grid layouts that feel stable and responsive by default.

## Rules
1. **Fluid Sizing (clamp)**: Use the `clamp()` function for all core typography to enable smooth viewport-aware scaling without excessive media queries.
   - Example: `font-size: clamp(2rem, 1.5rem + 2.5vw, 4rem);`
2. **Variable Font Mastery**: Leverage variable font axes (`wght`, `wdth`, `ital`, `slnt`) instead of loading multiple static weights.
3. **Subgrid Consistency**: Use `display: subgrid` for nested layouts to maintain alignment with the global layout grid.
4. **Leading & Line Height**: Enforce strict vertical rhythm. Base line height should be ~1.5 for body text and ~1.1-1.2 for headings.
5. **Legibility Guards**: Maximize readability by capping body text width to ~65-75 characters (approx. `60ch` or `70ch`).
6. **Neo-Brutalist Spacing**: Use bold, deliberate white space (margins/padding) to create a premium, high-end "magazine" feel.
7. **System Font Fallbacks**: Always provide a high-quality system fallback stack to prevent FOIT (Flash of Invisible Text).

## Design Philosophy (2026)
- **Hierarchy through Contrast**: Combine a bold, variable sans-serif for headings (e.g., Inter, Outfit) with a highly legible, optimized serif or mono for secondary details.
- **Micro-Typography**: Use `font-variant-numeric: tabular-nums` for data tables and `text-underline-offset` for refined link styling.
- **Optical Sizing**: Enable `font-optical-sizing: auto` for fonts that support it, ensuring clarity at small sizes and elegance at large sizes.

## Verification
- Resize viewport to confirm `clamp()` scaling is smooth and doesn't break layout.
- Verify subgrid alignment in browser dev tools (Grid overlay).
- Check contrast ratios for all typographic elements (WCAG 2.2 AA minimum).

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
