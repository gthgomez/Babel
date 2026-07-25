<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

---
name: code-review
description: >-
  Structured multi-pass code review of staged or unstaged git changes — or a
  specified file/directory. Covers correctness, security, performance, Babel
  control-plane integrity, style, and type-safety. Use when reviewing a diff,
  PR, or specific file before commit or merge. Triggers on: /code-review,
  "review this diff", "review my changes", "review this file/PR".
---

# Code Review

Multi-pass structured review of git changes or a specified scope.

## Inputs

| Source | How to specify |
|--------|----------------|
| Staged diff | `/code-review` (no args) — runs `git diff --cached` |
| All local changes | `/code-review --all` — runs `git diff HEAD` |
| Specific file/dir | `/code-review <path>` |
| Specific commit/branch | `/code-review <ref>` or `/code-review <base>..<head>` |
| User description | Arguments passed as `$ARGUMENTS` appended to context |

If `$ARGUMENTS` is provided, use it to focus or scope the review.

## Phase 0 — Gather Context

```powershell
# Determine what to review
git diff --cached --stat         # staged
git diff HEAD --stat             # all local changes
git log --oneline -5             # recent history for context
```

Read the files affected by the diff — do not rely on diff hunks alone. Understand the full function/class context.

Also read (when relevant to changed files):
- `C:\Workspace\Babel-private\CLAUDE.md` §Critical Invariants — for control-plane rules
- `C:\Workspace\Babel-private\prompt_catalog.yaml` — if catalog entries changed
- `C:\Workspace\Babel-private\.agents\rules\` — for project coding standards

## Phase 1 — Correctness

- Logic errors, off-by-one, incorrect null/undefined handling
- Missing error handling or unhandled promise rejections (TypeScript)
- Incorrect type assertions (`as any`, unsafe casts)
- State mutation side-effects that cross module boundaries
- Missing or incorrect return types
- Unreachable code / dead branches

## Phase 2 — Security

- Hardcoded secrets, API keys, tokens, or credentials
- Command injection risks in shell invocations (`exec`, `spawn`, template strings)
- Path traversal vulnerabilities
- Missing input sanitization or validation
- Insecure deserialization or `eval`-equivalent patterns
- Overly broad permission grants or capability escalation
- Prompt injection surface in LLM-facing strings (Babel-specific)

## Phase 3 — Performance

- N+1 patterns in loops that call async functions or filesystem operations
- Unbounded iteration over large collections without early exit
- Missing memoization / repeated computation of the same value
- Synchronous blocking calls in async contexts
- Unnecessary re-rendering or recomputation in UI components

## Phase 4 — Babel Control-Plane Integrity *(skip if no Babel files changed)*

Applies when diff touches: `prompt_catalog.yaml`, `00_System_Router/`, `01_Behavioral_OS/`, `03_Model_Adapters/`, `runtime/`, `tools/`, `babel-cli/src/`.

- Router changes: do not break existing `route_to` resolution paths
- Catalog changes: `id` uniqueness, `path` existence, `status` field valid
- Skill edits: frontmatter `name`/`description` preserved; no trigger regressions
- Compiled-memory tooling: adapter manifests consistent with router expectations
- TypeScript: no new type errors introduced

```powershell
# Run if control-plane files changed:
npm --prefix .\babel-cli run typecheck 2>&1 | Select-Object -Last 20
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
```

## Phase 5 — Style & Maintainability

- Naming clarity (variables, functions, types)
- Function/method length — flag anything over ~60 lines that could be decomposed
- Duplicated logic that could be extracted
- Missing or stale comments on non-obvious code
- Test coverage: are new branches covered? Are test file names consistent with source?

## Phase 6 — Output

Structure the review as follows. Omit any section with zero findings.

### Summary

One paragraph: what changed, overall risk level (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`), and whether it is safe to merge.

### Findings

For each finding:

| Field | Content |
|-------|---------|
| **File:Line** | e.g. `src/pipeline.ts:142` |
| **Severity** | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` / `SUGGESTION` |
| **Category** | Correctness / Security / Performance / Control-Plane / Style |
| **Issue** | Clear description of the problem |
| **Why** | Why this matters in this codebase |
| **Fix** | Concrete, minimal code-level suggestion |

### Praise

Call out 1–3 things done well. Code review is not only about problems.

### Merge Decision

`✅ APPROVE` — no blockers  
`⚠️ APPROVE WITH NOTES` — minor issues noted; author's call  
`🔁 REQUEST CHANGES` — one or more HIGH/CRITICAL findings; must be addressed  
`🚫 BLOCK` — CRITICAL security or control-plane regression

## Hard Rules

1. **Read source, not just diff** — always read full file context around changed lines.
2. **No hallucinated findings** — cite exact file paths and line numbers.
3. **Separate facts from suggestions** — use `SUGGESTION` severity for style opinions.
4. **Control-plane changes require typecheck** — run it; do not skip.
5. **Secrets = CRITICAL** — any credential in diff is an immediate blocker.
6. **Windows paths** — use full Windows paths in all shell commands.

## Triggers

- `/code-review`, `/cr`
- "review this diff", "review my changes", "review this PR"
- "review this file", "review before I commit"
- Diff analysis requested before a GitHub workflow run
