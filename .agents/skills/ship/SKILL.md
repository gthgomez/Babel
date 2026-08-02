---
name: ship
description: >
  Session → draft PR pipeline. Verify, stage, commit, push, and create a pull
  request in one command. The final step after task-helper resolve. Use when
  ready to ship completed work.
---

# /ship

Ship one reviewed release batch as a pull request. Runs the full pipeline:
inventory → classify → size-check → verify → explicit stage → commit → push →
draft PR → CI poll.

Contract: invokes the configured workspace shipping helper (`ship-slice.ps1`).

## Triggers

| Input | Behavior |
|-------|----------|
| `/ship` | Auto-detect project, full pipeline (dry-run) |
| `/ship -NoDryRun` | Actually ship — stage, commit, push, create PR |
| `/ship -Project babel -NoDryRun` | Ship a specific project |
| `/ship -NoVerify -NoDryRun` | Skip verify gate (emergency/trivial changes) |
| `/ship -NoDraft -NoDryRun` | Create a ready-to-merge PR (not draft) |
| `/ship -Message "fix: specific message"` | Custom commit message |
| "ship it", "create PR", "push and PR", "open a PR" | Same as `/ship -NoDryRun` |

## Pipeline Steps

```
1. INVENTORY          plan-public-commit.ps1 (all visible paths)
2. CLASSIFY           ship/split/vault/exclude/investigate/local-helper
3. SIZE CHECK         max 1,500 changed lines and 30 files by default
4. VERIFY             bv -Budget (blocks on failure)
5. BRANCH SAFETY      Refuses main/master
6. FORBIDDEN PATHS    Blocks internal docs, runs/, artifacts/, *.env, scratch
7. DIFF REVIEW        Shows exact batch paths and staged diff
8. STAGE              git add -- <planned paths> only
9. COMMIT             Conventional commit (auto-detects type from branch)
10. PUSH              git push -u origin HEAD
11. DRAFT PR          gh pr create --draft
12. CI POLL            gh pr checks (reports pending/complete/failed)
```

## Commit Message Auto-Detection

Branch `feat/ratchet-preflight` → `feat(babel): ratchet preflight`
Branch `fix/broken-build` → `fix(babel): broken build`
Branch `docs/readme-update` → `docs(babel): readme update`

Override with `-Message "custom: my message"`.

## Dirty Worktree Contract

`/ship` is a batch command, not a whole-worktree command. When the worktree is
dirty, first run the inventory tool and create a batch selection. The command
must refuse to stage when:

- any path is unclassified or assigned to multiple batches;
- a proposed batch contains vault-only docs, local settings, scratch files,
  generated benchmark data, or secret-risk filenames;
- the batch exceeds the default review budget;
- the same path has both staged and unstaged changes; or
- the requested batch has no explicit path list.

The agent should reuse the release map for subsequent batches instead of
re-reading and reinterpreting the complete worktree.

## Forbidden Paths (per project)

Configured in `.workspace-map.json` under `ship.forbidPaths`:

| Project | Forbidden |
|---------|-----------|
| babel | handoff-*.md, runs/, artifacts/, *.env, memory/ |
| android | *.keystore, *.jks, *.env, google-services.json |

## Lifecycle

```
/task-helper bootstrap ISSUE-NNN
  → implement …
  → /bv
  → /task-helper resolve ISSUE-NNN -NoDryRun
  → /ship -NoDryRun              ← this skill
  → /ci-triage -Pr <N>           ← monitor
```

## Dry-Run Default

`/ship` defaults to dry-run. Add `-NoDryRun` to actually:
- Stage and commit files
- Push to origin
- Create a PR on GitHub
- Poll CI checks

## Safety Gates

- **Blocks on verify failure:** Fix with `/bv` first
- **Blocks on forbidden paths:** Unstage with `git reset HEAD <file>`
- **Blocks on main/master:** Create a feature branch first
- **Blocks on dirty worktree with no selected batch:** Create a release map first
- **Never uses `git add -A`** for a mixed worktree
- **Blocks oversized batches** unless explicitly overridden and documented

## Related

- `task-helper` — bootstrap → resolve lifecycle (run before ship)
- `bv` — verify gate (called by ship)
- `ci-triage` — PR failure classifier (run after ship if CI fails)
- `branch-stack` — manage stacked PRs for dependent features
