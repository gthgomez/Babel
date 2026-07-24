<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Unix Shell Execution Protocol (v2.0)

**Category:** Lang
**Status:** Active
**Pairs with:** `domain_devops`
**Activation:** Load for bounded shell-script authoring tasks, POSIX command snippets, health checks, and small operational scripts where the output itself is a shell artifact.

---

## Purpose

This skill keeps shell-script tasks narrow, portable, and executor-safe.

When the task asks for a shell file, prefer a direct `file_write` of the requested script path over
inventing wrapper scripts, helper filenames, or platform-specific substitutes.

---

## Contract

1. Treat the requested script path as canonical.
2. Default to POSIX shell unless the task explicitly asks for Bash-only behavior.
3. Keep scripts small, single-purpose, and dependency-light.
4. Prefer `curl`, `wget`, `test`, `[`/`]`, `printf`, `echo`, and exit codes over shell-specific abstractions.
5. When a report file is also requested, write it to the exact requested report path. Do not invent alternate report filenames.

---

## Output Rules

- Use a shebang appropriate to the requested environment.
- Ensure the script exits non-zero on failure paths.
- Avoid placeholder comments in place of actual logic.
- Do not emit empty script files.
- Do not rename `.sh` outputs to `.bat` or `.ps1` unless the user explicitly requested that platform.

---

## Verification

Before claiming completion, confirm:
- the script file exists at the requested path
- the script body is non-empty
- success and failure paths are represented with explicit exit codes

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific conventions. It does not replace official framework or platform documentation.
- Version-specific guidance must be verified against current stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced library or tool version is outdated:** Flag as STALE. Recommend verification against current documentation.
- **Guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.

## Strategic Next Move
After every substantial response, end with one strategic next-move question.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 3 (Web & Tooling).
