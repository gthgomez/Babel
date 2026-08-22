<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

---
name: code-review
description: >-
  Defect-first review of what would merge: merge-base plus dirty tree plus
  untracked. Use for /code-review, /cr, "review this diff", "review my
  changes", or a specified path/range/PR. Does not post to GitHub — use Grok
  /review --pr for a PENDING review.
---

# /code-review

Thin router. Collect the target, apply the gate, write findings. Read-only.

Details: [references/contract.md](references/contract.md). The block below is the fallback if that file is never opened.

## 1. Collect

Derive `<skill-dir>` from this SKILL.md path (the harness announces it). Do not hard-code a Babel repo path.

```powershell
pwsh -NoProfile -File <skill-dir>/scripts/collect-target.ps1
```

The collector finds the git root itself. Flags: `-Staged` · `-Path <path>` · `-Range <A..B>` · `-Structure`. `#N` / PR URL → `gh pr diff` to *read* only.

If `STATUS: EMPTY`, print exactly this line and stop:

```text
No changes to review.
```

If `STATUS: TOO_LARGE` or `ERROR`, print `MESSAGE` and stop.

## 2. Non-negotiables (inlined)

**Default target** (what the collector already did): on `main`/`master`, `git diff HEAD` ∪ untracked; otherwise `git diff $(git merge-base HEAD <origin/main|origin/master|main|master>)` ∪ untracked. Not staged-only.

**Read-only.** Do not edit source, commit, push, or post a GitHub review. For PENDING GitHub comments use Grok `/review --pr`.

**Finding gate** — flag only if **all** are true:

- Affects correctness, security, performance, or meaningful maintainability
- Discrete and actionable
- Introduced by this change (except control-plane validation)
- Demonstrable from code / tests / call sites
- Author would probably fix it if they knew

Never flag: pre-existing (unless labeled `PRE-EXISTING`), CI-will-catch, speculative, intentional behavior, style nits, “function is 61 lines.”

**Schema**

```text
[P0|P1|P2|P3] Title — path:line
Category: bugs | security | control-plane | structure | tests
Why: one sentence, this codebase
Fix: minimal suggestion
```

P0 = secret or introduced control-plane regression → `BLOCK` and `REQUEST_CHANGES`.  
P1 → `REQUEST_CHANGES`. P2/P3 → `APPROVE_WITH_NOTES`. None → `APPROVE`.  
Zero qualifying findings: print exactly `No findings.` then residual risks / test gaps.

## 3. Lenses

Load a specialist file only when its lens is selected. If a lens is off, do **not** read that file and do **not** run its commands.

- **bugs** — always. Logic, null, races, wrong call sites, missing error paths.
- **security** — `LENSES` lists it, `SECRET_HINTS` non-empty, or `--security` → sibling `code-review-security/SKILL.md`
- **control-plane** — `LENSES` lists it **and** `CATALOG_PRESENT: true` → sibling `code-review-control/SKILL.md`
- **structure** — `LENSES` lists it, `CROSSES_1K` non-empty, or `--structure` → sibling `code-review-structure/SKILL.md`

Markdown-only paths stay on **bugs** only.

## 3b. Isolation

If this harness can spawn a **read-only** subagent (`spawn_subagent` with `capability_mode: read-only`, Claude `Task`, or equivalent):

1. Spawn **one subagent per selected specialist** (security / control-plane / structure). Bugs stay on the orchestrator.
2. Description prefix `[reviewer]`. Prompt: prepend the specialist SKILL.md; pass the collector report; **do not modify files**; write findings in the schema to `%TEMP%\babel-cr-<lens>.md`.
3. If a specialist spawn fails: warn and continue. If the whole review cannot run: stop.
4. Merge files, drop duplicate file+line+problem, **re-apply the finding gate**, then vote.

If the harness **cannot** spawn: apply selected specialist files inline in one pass. That is still a valid review. Do not claim ensemble benefits.

Never post to GitHub. Never implement fixes.

Read full file context around every listed hunk. Cite a line on the new side of the diff.

## 4. Output

1. One-line summary (mode, file count, lenses).
2. Findings in the schema, highest priority first.
3. Vote: `APPROVE` | `APPROVE_WITH_NOTES` | `REQUEST_CHANGES` | `BLOCK`.
4. Write the same text to `%TEMP%\babel-code-review.md` (overwrite). Do not commit a review file into the repo.

## Collision

This family is the daily review. Grok `/review` stays installed for PENDING GitHub reviews (`/review --pr`). Do not replace that command.
