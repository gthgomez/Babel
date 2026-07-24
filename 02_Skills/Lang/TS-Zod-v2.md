<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: TypeScript & Zod (v2.0)
**Category:** Language
**Status:** Active
**Last Verified:** 2026-04-25

## Package bridge

- **Canonical package:** `skills/ts-zod/` (`SKILL.md`, `skill.yaml`, `contracts/`, `examples/`, `tests/`)
- **Catalog id:** `skill_ts_zod`
- **This file:** Babel prompt routing and layer behavior only
- Do not duplicate schemas or examples here; use the package skill for I/O contracts and fixtures

## Core Strategy: Types Over Guesses
- **TypeScript (2026 Strict Mode):** Enable `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true` in `tsconfig.json`.
- **Zero Hallucination Policy:** No `any`. Use `unknown` for dynamic data and narrow types via type guards or validation.
- **Interfaces vs Types:** Use `interface` for entity/object shapes (better error messages). Use `type` for unions, intersections, and primitives.
- **Domain Modeling:** Define types based on business logic, not just as shadows of API responses.

## Runtime Validation: Trust Nothing
- **Edge Validation**: All external input (API, DB, MCP, User) must be parsed, not just cast.
- **Zod & Standard Schema**: Use Zod for validation. Prioritize "Standard Schema" compatible patterns for interoperability with modern libraries.
- **Zod v4 Constructors**: Use top-level constructors for string formats and strict objects: `z.uuid()` and `z.strictObject({ ... })`. Do not introduce legacy `z.string().uuid()` or `z.object(...).strict()` in new code.
- **Placement**: Validation happens at the entry boundary (Edge Functions/Backend) before logic or persistence.
- **Zod Schema Sharing**: Export schemas from a shared package/directory to keep Frontend and Backend in sync.
- **Zod Inference**: Use `z.infer<typeof Schema>` to keep types and schemas synchronized automatically.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific technical guidance. It does not replace official Supabase/PostgreSQL/TypeScript documentation.
- Version-specific guidance must be verified against current stable releases before use in production plans. Referenced API patterns may have changed since last verification.

## Failure Behavior of This Skill
- **Referenced API or version is outdated:** Flag as STALE. Recommend web-search verification against current documentation before proceeding.
- **Guidance conflicts with another skill's recommendation:** Activate `coherence-linter` to detect and resolve the contradiction. Do not silently pick one.
- **Skill is loaded for a task outside its domain:** Boundaries section defines scope limits. Redirect to the appropriate domain skill.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening technical guidance against API changes.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for auditing skill currency.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification of version pins and API references.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions with related skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-19.
