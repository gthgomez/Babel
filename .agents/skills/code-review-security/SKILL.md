<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: code-review-security
description: >-
  Security lens for /code-review: secrets, injection, authz, prompt-injection.
  Use when the collector lists security, SECRET_HINTS is non-empty, or the user
  runs /code-review-security. Read-only. Does not post to GitHub.
---

# /code-review-security

Security lens only. Use the parent router gate and P0–P3 schema — do not invent another severity system. Read-only. Do not edit source, commit, push, or post. If spawned, stay read-only and write only `%TEMP%\babel-cr-security.md`.

If invoked standalone, collect first using the sibling `code-review` skill's collector (`<code-review-skill-dir>/scripts/collect-target.ps1`). Empty target → `No changes to review.`

## Scope

- Hardcoded secrets, tokens, private keys, `.env` values in the diff
- Command injection (`exec` / `spawn` / shell template strings)
- Path traversal on user-controlled paths
- Missing authn/authz or widened permissions
- Prompt-injection surface in LLM-facing strings
- Security checks **removed** (git blame / history on deleted guards)

Skip docs-only and formatting hunks. Classify by risk, not diff size. A two-line auth change is HIGH until proven otherwise.

## Gate (same as router)

Flag only if all are true: meaningful security impact; discrete; introduced by this change; demonstrable; author would probably fix it.

`SECRET_HINTS` from the collector, or any credential you confirm in the new file, is **P0** and **BLOCK**. Category: `security`.

Do not flag theoretical “an attacker might” without a call path. Do not flag linter/type issues.

## Output

Same schema as `/code-review`. Vote with the router map. If this lens is the only one and there are no qualifying findings: `No findings.`
