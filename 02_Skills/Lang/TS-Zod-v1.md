<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: TypeScript & Zod (v1.0)
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
