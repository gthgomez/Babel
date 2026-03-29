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

## Core Strategy: Types Over Guesses
- **TypeScript (Strict Mode) Mandatory:** No `any`. Use `unknown` or specific interfaces.
- **Static Typing:** Leverage types to turn hallucinations into compiler errors before they reach runtime.
- **Interfaces > Types:** Prefer `interface` for object definitions to allow for easy extension.

## Runtime Validation: Trust Nothing
- **Validation at the Edge:** All external input (API, DB, User) must be validated.
- **Zod (TypeScript):** Use Zod schemas for all runtime validation.
- **Placement:** Validation must happen in Edge Functions or Backend before any DB write.
- **Schema Sharing:** Use a shared schema file if both Frontend and Backend consume the same data structure.
