---
name: ship
description: >
  Session → draft PR pipeline. Verify, stage, commit, push, and create a pull
  request in one command. The final step after task-helper resolve. Use when
  ready to ship completed work.
---

# /ship

Ship completed work as a pull request. Runs the full pipeline: verify gate →
forbidden-path scan → stage → commit → push → draft PR → CI poll.

Contract: invokes `<BABEL_TOOLS_ROOT>/ship-slice.ps1`.

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
1. VERIFY             bv -Budget (blocks on failure)
2. BRANCH SAFETY      Refuses main/master
3. FORBIDDEN PATHS    Blocks if handoff-*.md, runs/, artifacts/, *.env staged
4. DIFF REVIEW        Shows git status --short + git diff --stat
5. STAGE              git add -A
6. COMMIT             Conventional commit (auto-detects type from branch)
7. PUSH               git push -u origin HEAD
8. DRAFT PR           gh pr create --draft
9. CI POLL            gh pr checks (reports pending/complete/failed)
```

## Commit Message Auto-Detection

Branch `feat/ratchet-preflight` → `feat(babel): ratchet preflight`
Branch `fix/broken-build` → `fix(babel): broken build`
Branch `docs/readme-update` → `docs(babel): readme update`

Override with `-Message "custom: my message"`.

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
- **Blocks on dirty worktree with no changes:** Nothing to ship

## Related

- `task-helper` — bootstrap → resolve lifecycle (run before ship)
- `bv` — verify gate (called by ship)
- `ci-triage` — PR failure classifier (run after ship if CI fails)
- `branch-stack` — manage stacked PRs for dependent features
