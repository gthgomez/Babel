<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
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

## Workflow

1. Read `.\CLAUDE.md` §Critical Invariants and §High-Risk Zones for the protected boundaries.
2. Run the narrowest relevant checks:
   ```powershell
   npm --prefix .\babel-cli run typecheck
   npm --prefix .\babel-cli run build
   powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
   powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-control-plane.ps1
   ```
3. If the change touched compiled-memory tooling, also run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\test-sync-model-manifests.ps1
   ```
4. Report the first failing check or a clean validation summary.
