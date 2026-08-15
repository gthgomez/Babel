---
name: search-fast
description: Fast dot-directory and hidden-path discovery when Glob or Grep fail or time out. Use when searching .claude/, .agents/, .github/, or any dot-directory, when Glob returns empty results for files that exist, or when a hidden-path search needs a deterministic PowerShell fallback.
---

# /search-fast

Fast fallback search for dot-directories and hidden paths, for when Glob/Grep
miss them. Glob/Grep follow ripgrep semantics and skip hidden directories by
default; on this repo an unscoped Glob over dot-dir trees can hit the 20s
timeout or silently return "no files found".

## When to use

- Searching anything under `.claude/`, `.agents/`, `.github/`, `.vscode/`, or any dot-directory.
- Glob returns "no files found" for files that exist (hidden-dir skip or silent timeout).
- Grep returns nothing for patterns that should match files in hidden directories (Grep skips hidden dirs by default; pass explicit paths).
- Any config/rule auditing task (CLAUDE.md §Quick Traverse dot-dirs: `.agents/rules/`, `.agents/skills/`).

## Env fix note (2026-08-15)

`CLAUDE_CODE_GLOB_NO_IGNORE=false` and `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS=60` are
set in `~/.claude/settings.json`. Once active (next session), Glob honors
`.gitignore`/`.rgignore` and stops scanning gitignored trees (`node_modules/`,
`dist/`, `runs/`). Dot-directories are still included by Glob unless gitignored;
`.claude/` IS gitignored in this repo, so it remains a search-fast use case.

## Fast discovery (primary)

PowerShell `Get-ChildItem -Force` — measured ~49-93 ms on `.claude/` vs the 20s
Glob timeout.

```powershell
# list everything under a dot-dir, 2 levels deep, names only
Get-ChildItem -Force -Recurse -Depth 2 -Name .claude
Get-ChildItem -Force -Recurse -Depth 2 -Name .agents

# filtered by name pattern
Get-ChildItem -Force -Recurse -Name .claude -Filter *.md

# content search fallback (Grep skips hidden dirs by default)
Get-ChildItem -Force -Recurse -File .agents |
  Select-String -Pattern 'some-pattern' -List
```

## Rules

- Always use `-Force` — dot-directories are hidden; without it you get an empty result.
- Scope with explicit paths — never recurse the repo root (CLAUDE.md gotcha 3).
- Use `-Encoding utf8` when redirecting output or when content may be non-ASCII.
- Grep hidden-dir caveat: Grep skips hidden files/dirs by default — pass
  explicit paths (`path: .agents/rules`) when you must use Grep, or use the
  PowerShell fallback above.
- Prefer `Read` with the exact path when you already know the file.

## Why not Glob

Pre-env-fix, Glob scans without honoring ignore files and times out at 20s on
dot-dir trees; after the env fix it skips gitignored trees but still cannot be
pointed at gitignored `.claude/`. PowerShell `Get-ChildItem -Force` is
deterministic, instant, and works for every dot-dir.
