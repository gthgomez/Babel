---
name: ts-zod
description: Write, modify, or review strict TypeScript and Zod validation for API input, database data, form data, CLI args, config files, tool payloads, webhooks, model output, shared schemas, and contract-safe boundary parsing.
---

## Prompt bridge

- **Babel catalog id:** `skill_ts_zod`
- **Prompt-layer owner:** `02_Skills/Lang/TS-Zod-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# TypeScript And Zod

Use this skill when writing, modifying, or reviewing TypeScript code that crosses a
trust boundary: API input, database data, form data, CLI args, config files, tool
payloads, webhook payloads, or model output.

## Workflow

1. Find the real type/schema definitions before planning changes.
2. Model domain objects explicitly; do not mirror vague API blobs.
3. Parse untrusted data at the edge with Zod or the repo's established validator.
4. Infer TypeScript types from schemas where practical.
5. Preserve strictness; do not use `any` to make errors disappear.
6. Run typecheck and the narrowest relevant tests.

## Type Rules

- Prefer `unknown` plus narrowing over `any`.
- Use `interface` for object/entity shapes when extension/readability matters.
- Use `type` for unions, intersections, mapped types, and primitives.
- Keep optional fields intentional. Do not add `?` only to silence callers.
- Treat schema changes as contract changes when consumers exist.

## Zod Rules

- Use current Zod v4 style for new code.
- Prefer strict object schemas at external boundaries.
- Validate before persistence, rendering, or business logic.
- Use coercion only when the source is known to be stringly typed.
- Keep shared schemas in shared modules when client and server both consume them.

## Verification

- Run `npm run typecheck` or the repo's equivalent.
- Run schema/parser tests for changed validators.
- Add fixtures for accepted and rejected inputs when behavior changes.
