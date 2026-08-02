---
name: branch-stack
description: >
  Manage stacked feature branches with --update-refs rebase and chained PR
  creation. Use when working on sequential dependent features (W0→W1→W2)
  that would otherwise serialize through main.
---

# /branch-stack

Manage a stack of dependent feature branches as a single unit — rebase the
stack, push all refs, and create chained PRs where each PR's base is its
parent branch instead of main.

Contract: invokes `tools/ship-stack.ps1` and integrates with `github-workflow` skill.

## Triggers

| Input | Behavior |
|-------|----------|
| `/branch-stack init <name-prefix>` | Create a new stack from current branch |
| `/branch-stack rebase` | Rebase the full stack on latest main with --update-refs |
| `/branch-stack push` | Force-push all stack branches (with lease) |
| `/branch-stack pr` | Create chained PRs for all branches in the stack |
| `/branch-stack land` | Merge bottom-up and rebase remaining children |
| `/branch-stack status` | Show stack topology and PR status for each branch |
| `/branch-stack abandon` | Remove stack metadata (does not delete branches) |

## Stack File

Stack topology is stored in `.babel-stack.json` at the repo root:

```json
{
  "name": "implementor-roadmap",
  "base": "main",
  "branches": [
    "feat/implementor-roadmap-w0-w1",
    "feat/w1-metric-gate-ttf",
    "feat/w1-exit-residual-w22-explore-feeder"
  ],
  "created": "2026-07-15T10:00:00Z"
}
```

## Workflow

### Creating a stack
```
/branch-stack init w3-grok
```
Creates `.babel-stack.json` with the current branch as the first entry.

### Adding to a stack
```
git checkout -b feat/w3-4-next-step feat/w3-3-grok-shadow-scorecard
/branch-stack status   # auto-detects new child branch
```

### Shipping a stack
```
/branch-stack rebase   # rebase all on latest main
/branch-stack push     # push all with --force-with-lease
/branch-stack pr       # create chained PRs
```

### Landing a stack (after reviews)
```
/branch-stack land     # merge bottom-up, rebase children after each merge
```

## PR Body Template

Each PR body auto-includes:
```markdown
🔗 **Stack:** `w3-grok` (branch 3 of 4)
- ⬇️ Merge #152 (`feat/w3-2`) first
- ➡️ This PR (#153)
- ⬆️ Then #154 (`feat/w3-4`) after this

🤖 Generated with [Codex](https://Codex.com/Codex)
```

## Safety Rules

- Never land a stack with unmerged parents
- Always rebase before creating PRs
- Use `--force-with-lease`, never `--force`
- If a mid-stack branch gains commits after child branches were created, rebase the full stack first
- Delete `.babel-stack.json` after the entire stack is landed

## Related

- `github-workflow` — individual PR creation and CI monitoring
- `ci-dry-run` — run CI checks locally before pushing the stack
