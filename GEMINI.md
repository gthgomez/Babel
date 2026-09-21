<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

<!--
status: ACTIVE
last_verified: 2026-09-20
-->
# GEMINI.md — Babel Gemini Adapter

This adapter supplements, but does not replace, the contributor router in
[AGENTS.md](./AGENTS.md). Start repository work there, then read
[PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) for Babel facts and contracts.

## Gemini-Specific Guidance

- Be concise, structured, and file-backed.
- On Windows, prefer PowerShell-native commands rather than Bash heredocs or
  Unix-only syntax.
- Preserve contracts before refactoring prompt assets and distinguish observed
  facts from inference.
- Use only host-supported tools and report unavailable capabilities instead of
  assuming another model's tool surface.

## Targeted Pointers

- For Babel invocation or stack assembly, use [INTEGRATION.md](./INTEGRATION.md)
  and `prompt_catalog.yaml`.
- For model-specific catalog, skill-porting, or commit details, load the
  relevant selected rule rather than treating this adapter as policy authority.
