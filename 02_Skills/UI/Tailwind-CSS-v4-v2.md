<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Tailwind CSS v4.0 & Modern Styling (v2.0)

## Purpose
Establishes the CSS-first paradigm for Tailwind CSS v4.0+ in high-end SaaS applications.

## Rules
1. **CSS-First Configuration**: Eliminate `tailwind.config.js`. Use the `@theme` directive in the main CSS entry file to define tokens.
   ```css
   @import "tailwindcss";
   @theme {
     --color-brand: oklch(0.62 0.17 256.5); /* Modern OKLCH color space */
     --font-brand: "Outfit", sans-serif;
   }
   ```
2. **OKLCH Color Space**: Use `oklch()` for color definitions to ensure perceptual uniformity and wider gamut support. Avoid hex/rgb where possible.
3. **Container Queries**: Use native `@container` support (e.g., `@container-md:grid-cols-2`) for components that need to be responsive relative to their parent, not just the viewport.
4. **Subgrid Alignment**: Use `grid-cols-subgrid` for nested elements that must align with a parent grid. Essential for "Bento Grid" layouts.
5. **Zero-JavaScript Build**: Leverage the Lightning CSS-based compiler for ultra-fast builds and reduced runtime overhead.
6. **Modern Gradients**: Use `bg-linear-to-r` (and other v4 syntax) for smooth, high-gamut linear and radial gradients.
7. **Logical Properties**: Prefer logical properties (e.g., `ms-4`, `pe-8`) over physical directions (`ml-4`, `pr-8`) to support RTL/LTR naturally.

## Aesthetic Standards (2026)
- **High-Contrast Accents**: Vibrant brand colors on deep neutral backgrounds.
- **Neo-Brutalist Structure**: Bold borders and consistent spacing (use subgrid).
- **Interactive States**: Use `hover:`, `focus-visible:`, and `group-hover:` for subtle interactive scaling and color shifts.

## Verification
- Verify that `@theme` variables are correctly picked up by the compiler.
- Check accessibility contrast ratios for `oklch()` colors.
- Test responsive layouts using both viewport and container queries.

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

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 3 (Web & Tooling).
