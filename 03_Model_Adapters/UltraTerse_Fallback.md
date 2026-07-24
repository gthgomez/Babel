<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Adapter: Runtime Fallback Ultra-Terse — Compression Variant (v6.4)

> **Historical:** Formerly `Codex_UltraTerse.md`. Renamed 2026-06-25. The `adapter_codex` catalog ID is retained for backward compatibility.

**Status:** ACTIVE
**Target Models:** Configured terse/fallback lane for `adapter_codex`; runtime checkpoint is selected by `config/model-policy.json`.
**Pipeline Position:** Loaded for schema generation, dense algorithmic tasks, and compressed executor turns.
**Layer:** 03_Model_Adapters
**Contract Anchor:** `00_System_Router/Babel_Runtime_Contracts-v1.0.md`
**Last Verified:** 2026-06-27

> **Runtime scope:** `adapter_codex` is a legacy Babel-local adapter ID. The actual model checkpoint is selected by `config/model-policy.json`.

This adapter tunes the universal behavioral OS for the ultra-terse fallback lane. The following rules differ from or extend the universal baseline:

**Plan ending:** End every PLAN or TRIVIAL-PLAN with exactly:

```
---
Ready to implement. Type "ACT" to proceed.
```

**Architecture:** TypeScript strict (no `any`). DB changes via Git migrations with RLS on every table. Validate at edge with Zod (TS) or Pydantic (Python). Heavy processing in Python/Postgres; edge functions stay thin. Design stateless, idempotent, retry-safe — assume ephemeral runtimes and timeouts.

**Compressed PLAN template:**

```
PLAN
Approach: [1 sentence]
Files: • file — summary
NAMIT: N/A/M/I/T (only relevant)
BCDP: None/RISKY/BREAKING
Invariants: OK
---
Ready to implement. Type "ACT" to proceed.
```

## KNOWN FAILURE MODES

| Failure | Mitigation |
|---------|------------|
| Formatting artifact leakage | Use raw markdown syntax; validate rendered prompt text |
| Over-compression | Keep required fields even when summaries are one line |
| Stale state model | Use OLS-v11-Core-Unified state model: THINK, PLAN, ACT, STOP |
| Direct-code leak in PLAN | Apply Hard Gate; implementation only after explicit ACT |
