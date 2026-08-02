---
name: context-compiler
description: >
  Compile a hash-keyed, token-efficient workspace+project context pack for agent
  startup. Use at session start, after /handoff-resume, when switching projects,
  or when policy files may have changed. Wraps <BABEL_TOOLS_ROOT>/context-compiler.ps1.
---

# /context-compiler

Produces a ~2–4KB markdown digest of always-loaded policies (AGENTS.md,
ENGINEERING.md, USER.md) plus project AGENTS.md / PROJECT_CONTEXT.md, with
SHA256 cache invalidation under `<BABEL_RUNTIME_ROOT>/`.

Contract: invokes `<BABEL_TOOLS_ROOT>/context-compiler.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/context-compiler` | Auto-detect project, compile or serve cache |
| `/context-compiler -Project babel` | Force project |
| `/context-compiler -Force` | Recompile ignoring cache |
| `/context-compiler -Show` | Print pack to terminal |
| `/context-compiler -Json` | Machine envelope including pack text |
| "compile context", "context pack", "startup digest" | Same as default |

## Outputs

| Path | Content |
|------|---------|
| `<BABEL_RUNTIME_ROOT>/context-snapshot-<project>.json` | Full snapshot + fingerprints + pack |
| `<BABEL_RUNTIME_ROOT>/context-pack-<project>.md` | Markdown pack for injection |

JSON envelope fields: `status`, `summary`, `data.pack`, `data.cache_status`,
`data.fingerprint`, `data.pack_path`, `nextActions`, `timestamp`.

## Agent usage

1. Run compiler for the active project.
2. Prefer reading `context-pack-<project>.md` instead of re-reading full AGENTS/ENGINEERING/USER when the cache is a **hit** and the task is not policy-maintenance.
3. On **cache miss** or policy-edit tasks, still open full source files for the sections you change.
4. Full sources remain authoritative; the pack is a token-saving digest only.

## Lifecycle

```
ws babel
  → /context-compiler          ← inject digest
  → /task-helper bootstrap …
  → implement …
  → /bv
  → /ship
```

## Related

- `task-helper` — may surface issue/branch state also reflected in pack git/handoff sections
- `bv` — verify after work
- Phase 7 `handoff-repro` — executable checks companion to handoff prose
