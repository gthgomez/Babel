---
name: evidence-compile
description: >
  Auto-generate progress/status documents from git history. Parses the
  implementor roadmap markdown, cross-references with git log for completed
  waves, and updates status checkboxes. Eliminates manual status ledger
  maintenance alongside every feature commit.
---

# /evidence-compile

Generate or update progress-status documents by cross-referencing the
implementor roadmap against git history. Reads roadmap checkboxes,
matches completed waves via commit messages, and produces updated status
tables.

Contract: invokes `tools/compile-evidence.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/evidence-compile` | Update the current implementor roadmap status file |
| `/evidence-compile --since "2026-07-10"` | Only scan commits from that date |
| `/evidence-compile --dry-run` | Show what would change without writing |
| `/evidence-compile --roadmap <path>` | Target a specific roadmap file |
| "compile evidence", "update status", "roadmap progress", "update progress doc" | Same as default |

## Workflow

1. Identify the active roadmap file in `docs/plans/` or `docs/status/`
2. Scan `git log --oneline --since=<last update>` for `feat(harness): W*` commits
3. Cross-reference wave IDs (W0.1, W1.3, etc.) against roadmap checkboxes
4. Detect newly completed waves:
   - A wave is "complete" if a commit message contains `feat(harness): W<N>` AND the status file currently shows `- [ ]` or `Not started`
5. Update the status file:
   - Change `- [ ]` → `- [x]` for completed waves
   - Add the commit SHA as evidence
   - Update `last_verified` timestamp in the HTML comment header
6. Report what changed:
   ```
   Updated IMPLEMENTOR_ROADMAP_W0_W1_PROGRESS_2026-07-15.md:
     ✗→✓ W0.2 multi-tool protocol (7784e64)
     ✗→✓ W1.1 shell soft budget (7784e64)
     — W1.5 /why-stopped (already done)
   3 waves updated, 5 already complete, 2 still pending
   ```

## When to Run

- After shipping a feature that maps to a roadmap wave
- Before `/handoff` — ensures the status doc reflects current reality
- When asked "what's our progress on the roadmap?"
- As a periodic checkpoint (end of day / end of wave)

## Roadmap File Detection

The skill auto-discovers roadmap files by:
1. Checking `docs/plans/` for files matching `*ROADMAP*.md` or `*roadmap*.md`
2. Checking `docs/status/` for files matching `*PROGRESS*.md` or `*progress*.md`
3. Reading the most recently modified file as the active target

## Related

- `handoff` — create a session checkpoint
- `github-workflow` — ship the evidence commit
