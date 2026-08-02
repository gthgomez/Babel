---
name: bv
description: >
  Unified verify gate — auto-detects project and runs the right checks.
  One command for every project: Babel (tsc+unit+budget), Android (gradle),
  GPCGuard (npm), and everything in .workspace-map.json. Use before shipping
  or as /bv to invoke directly.
---

# /bv

Run the project-appropriate verify checks. Auto-detects which project you're
in and runs the right adapter. Wraps every project's verify toolchain behind
a single CLI.

Contract: invokes `<BABEL_TOOLS_ROOT>/bv.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/bv` | Auto-detect project, run default checks |
| `/bv -Full` | Run all configured checks (not just defaults) |
| `/bv -Budget` | Run only pre-push / budget checks |
| `/bv -Project android` | Run checks for a specific project |
| `/bv -List` | Show what would run (dry-run) |
| `/bv -Json` | Machine-readable output for scripting |
| "verify", "run checks", "precheck", "pre-check" | Same as default `/bv` |

## Per-Project Checks

### Babel (adapter: babel)
- **Default:** `tsc --noEmit` + `tsx --test`
- **Budget:** `preflight-ratchet.ps1` + `validate-all.ps1`
- **Full:** tsc + unit + budget + catalog + Docker CI

### Android (adapter: gradle)
- **Default:** `./gradlew lint` + `./gradlew test`
- **Full:** lint + test + assembleDebug

### GPCGuard / AuditGuard (adapter: npm)
- **Default:** `npm run lint` + `npm run build` + `npm test`
- **Full:** same as default

### Project_AI / Scout (adapter: node)
- **Default:** `npm run lint` + `npm test`

## Output Format

```
bv GREEN — babel [babel] All 2 check(s) passed (12.4s)
bv YELLOW — babel [babel] 1 passed, 1 failed (8.1s)
bv RED — android [gradle] All 3 check(s) failed (45.0s)
```

JSON mode returns structured results with per-check pass/fail, timing, and
truncated output. Use `-Json` when scripting or feeding into task-helper.

## Lifecycle

```
ws babel
  → /task-helper bootstrap ISSUE-NNN
  → implement …
  → /bv                  ← verify (quick)
  → /bv -Full            ← verify (comprehensive, before ship)
  → /task-helper resolve
  → /ship
```

## Related

- `task-helper` — bootstrap/precheck/resolve lifecycle (calls bv internally)
- `ship-slice` — session → draft PR (calls bv as preflight)
- `ratchet-preflight` — Babel-specific budget check (subset of bv -Budget)
