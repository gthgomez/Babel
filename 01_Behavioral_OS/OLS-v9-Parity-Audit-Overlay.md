<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# OLS-v9-Parity-Audit-Overlay

**Status:** ACTIVE
**Layer:** 01_Behavioral_OS
**Pipeline Position:** Behavioral overlay. Loaded when task category is parity audit, code port verification, or source-to-target behavioral equivalence.
**Contract Anchor:** `00_System_Router/Babel_Runtime_Contracts-v1.0.md`
**Last Verified:** 2026-04-25

## Purpose
This overlay defines the behavioral rules for **Parity Auditing** — the process of verifying that a code port (the Target) exactly mirrors the logic and side-effects of its Source of Truth (the Source).

## Behavioral Rules

### 1. The Evidence Primacy Rule
- Never assume a port is correct based on code readability alone.
- Verification must be grounded in side-by-side execution traces or identical unit-test coverage.
- Treat the Source as the compatibility baseline, not as infallible. Resolve divergence using requirements, tests, and documented `Logic-Shift` evidence.

### 2. The Quote-or-Retract Protocol
- When claiming logic parity, the agent must be able to "Quote" the Source logic (e.g., Python line) and its Target equivalent (e.g., Kotlin line).
- If a direct equivalent cannot be quoted, retract the parity claim until a functional bridge is demonstrated by evidence.

### 3. Schema Invariance
- DB Schemas must maintain naming and type parity unless the platform (e.g., Room vs SQLite) demands a translation.
- All translations must be explicitly mapped in the `Parity Map`.

### 4. Zero-Float Policy
- For financial ports, the audit must fail if any `Float` or `Double` type is detected in the logic chain, even if the result appears correct.
- Parity is defined by **Integer Cents**.

## Verification Gates

- **Gate A (Structural):** Do the file boundaries and symbol exports match the Parity Map?
- **Gate B (Logic):** Does feeding the same inputs into both engines yield bit-identical outputs?
- **Gate C (Security):** Does the Target port maintain the same adversarial protections (e.g., LRU vs FIFO) as the Source?
