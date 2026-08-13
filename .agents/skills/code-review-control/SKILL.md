<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: code-review-control
description: >-
  Babel control-plane lens for /code-review (catalog, router, skills). Path-routed
  when prompt_catalog.yaml exists at repo root. Not a standalone daily command.
disable-model-invocation: true
---

# code-review-control

Control-plane lens. The `/code-review` router reads this file only when the collector lists `control-plane` **and** `CATALOG_PRESENT: true`. Do not run this lens because the folder is named Babel-private.

Use the parent router gate and P0–P3 schema. Read-only. Do not edit source, commit, push, or post. If spawned, stay read-only and write only `%TEMP%\babel-cr-control.md`.

## When to skip

- `CATALOG_PRESENT: false` — stop; this is not a Babel control-plane repo.
- `LENSES` does not include `control-plane` — the router must not load this file.

## Check

- Catalog: `id` uniqueness, `path` exists, `status` valid (if `prompt_catalog.yaml` is in `FILES` or validate is run)
- Router: do not break existing `route_to` resolution (`00_System_Router/`)
- Skills: frontmatter `name` / `description` preserved; no trigger regressions
- TypeScript in `babel-cli/src/` or `runtime/`: no new type errors introduced by this change

If the tools exist, run:

```powershell
npm --prefix .\babel-cli run typecheck
pwsh -File .\tools\validate-catalog.ps1
```

## PRE-EXISTING

Validate/typecheck failures on files **not** in this change, or on the catalog when `CATALOG_IN_DIFF: false`, get label `PRE-EXISTING`. They **do not** enter the merge vote.

Only a breakage **introduced by this change** may be P0/P1. Introduced catalog/router regression → P0, `BLOCK`, category `control-plane`.

## Output

Same schema as `/code-review`. Do not emit control-plane commands or findings when this lens was not selected.
