<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: code-review-structure
description: >-
  Optional maintainability lens for /code-review: spaghetti growth, thin
  wrappers, layer leaks, files this change pushes across 1000 lines. Use when
  the collector lists structure, CROSSES_1K is set, or the user passed
  --structure. Never the default review. Read-only.
disable-model-invocation: true
---

# code-review-structure

Structure lens only. The router loads this file when `LENSES` includes `structure`, `CROSSES_1K` is non-empty, or the user passed `--structure`.

Use the parent router gate and P0–P3 schema. Read-only. Do not edit source, commit, push, or restructure the branch. If spawned, stay read-only and write only `%TEMP%\babel-cr-structure.md`.

## Look for

- This change pushes a file from under 1000 lines to 1000+ (`CROSSES_1K`)
- New special-case branches bolted onto an unrelated flow
- Thin wrappers / identity abstractions
- Feature logic leaking into a shared path
- A plausible deletion of complexity (not moving the same mess)

## Severity

These are **not** merge blockers unless they create a real correctness or security problem (that belongs on the bugs/security lens).

- File crossing 1000 lines because of this change → P2 or P3, category `structure`
- Spaghetti growth that makes the surrounding code harder to reason about → P2
- Missed “code judo” with no harm → P3 or omit

Do not treat “a cleaner model exists” as `REQUEST_CHANGES`. Do not implement the refactor.

## Output

Same schema as `/code-review`. If this is the only lens and nothing qualifies: `No findings.`
