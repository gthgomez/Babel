<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

---
name: validate-control-plane
description: Validates Babel control-plane changes after edits to routers, catalog, runtime harness, or resolver tooling. Use when prompt routing, stack resolution, or compiled-memory behavior may have changed.
---

# Validate Babel Control Plane

## Command reference

Root `AGENTS.md` owns contributor verification policy. Product routing contracts
are cataloged independently. The executable owners below provide checks selected
for the affected surface; this skill adds no mandatory validation cycle.

```powershell
npm --prefix babel-cli run typecheck
npm --prefix babel-cli run build
pwsh tools/validate-all.ps1
Get-Help ./tools/resolve-local-stack.ps1
```

Inspect the resolver's parameters and the affected package test scripts to choose
a concrete routing fixture. Compiled-memory behavior is tested through the
current implementation's tests; no model-manifest sync helper is shipped here.
Report the commands actually executed and their results.
