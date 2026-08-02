---
name: task-helper
description: >
  Unified task lifecycle harness — bootstrap → precheck → resolve. One command
  to start work, verify it, and close it out. Generates brain stubs for all
  four CLIs. Composes with issue-lifecycle, bv, and ship-slice.
---

# /task-helper

Start, verify, and resolve tasks with a single tool. Orchestrates issue state
transitions, git branches, daily logs, brain stubs, and commit skeletons.
Works identically across Codex, Codex, Grok, and Gemini.

Contract: invokes `<BABEL_TOOLS_ROOT>/task-helper.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/task-helper bootstrap ISSUE-NNN` | Start work: transition issue, create branch, write stubs |
| `/task-helper bootstrap ISSUE-NNN -Project babel` | Start work in a specific project |
| `/task-helper precheck` | Validate + verify (calls bv -Budget internally) |
| `/task-helper precheck -Project android` | Precheck for a specific project |
| `/task-helper resolve ISSUE-NNN` | Close out: walkthrough, EVIDENCE log, resolved state |
| "start task", "bootstrap task", "resolve task", "close task" | Same as bootstrap/resolve |

## Bootstrap (Start Work)

```
/task-helper bootstrap ISSUE-042 -Project babel -NoDryRun
```

Does all of this in one step:
1. Reads issue from `<BABEL_ISSUES_ROOT>/ISSUE-042.md`
2. Transitions issue state to `in-progress`
3. Creates git branch `issue/ISSUE-042-task-slug`
4. Writes daily log stub in `memory/YYYY-MM-DD.md`
5. Generates brain stubs for all four CLIs:
   - **Codex:** `<repo-root>/.Codex/tasks/ISSUE-042.md`
   - **Codex:** `<repo-root>/.codex/brain/ISSUE-042/task.md` + `implementation_plan.md`
   - **Grok:** Reads HARNESS.md + AGENTS.md naturally (no stub needed)
   - **Gemini:** `~/.gemini/antigravity/brain/<uuid>/task.md` + `implementation_plan.md`
6. Shows the verify plan (checks that will run)
7. Prints: "Ready. Next: implement → bv → resolve → ship-slice"

**Always run with -NoDryRun** to actually execute. Default is dry-run.

## Precheck (Verify Before Ship)

```
/task-helper precheck -Project babel
```

Runs:
1. Issue frontmatter validation
2. Workspace structure lint (if available)
3. `bv -Budget` (project verify gate)
4. Git dirty check

Output: PASS/FAIL with next actions.

## Resolve (Close Task)

```
/task-helper resolve ISSUE-042 -Project babel -NoDryRun -Resolution "Fixed the thing by doing X"
```

Does all of this:
1. Runs precheck (blocks if verify fails)
2. Generates walkthrough from `git diff --stat`
3. Writes walkthrough as Codex + Gemini brain stubs
4. Appends `EVIDENCE:` to daily log with branch + commit info
5. Transitions issue → resolved
6. Generates a commit skeleton message
7. Prints: "Resolved. Next: commit → ship-slice"

## Lifecycle

```
/task-helper bootstrap ISSUE-NNN  ← start
  → implement …
  → /bv                            ← verify
  → /task-helper resolve ISSUE-NNN ← close
  → /ship                          ← PR
```

## Dry-Run Default

Bootstrap and resolve default to dry-run. Add `-NoDryRun` to actually:
- Transition issue state
- Create branches
- Write files to disk
- Append to daily logs

Precheck is always live (no dry-run mode — it only reads).

## Related

- `bv` — project verify gate (called by precheck)
- `ship-slice` — session → draft PR (run after resolve)
- `ws` — project jump (run before bootstrap)
- `issue-lifecycle.ps1` — underlying issue state machine (composed by task-helper)
