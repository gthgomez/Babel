---
name: dirty-worktree-triage
description: Triage dirty git worktrees before commits, releases, PRs, or handoffs; classify modified, staged, and untracked files into commit-now, separate-commit, defer-review, and local-only buckets using sampled diff evidence.
---

## Prompt bridge

- **Babel catalog id:** `skill_dirty_worktree_triage`
- **Prompt-layer owner:** `02_Skills/Governance/Dirty-Worktree-Triage-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Dirty Worktree Triage

Use this skill when a repository already has modified, staged, or untracked files and
the user needs to decide what belongs in the current change, what needs a separate
commit, and what should stay local.

## Workflow

1. Capture `git status --short --branch`.
2. Capture changed filenames and diff stats.
3. Cluster files by change intent, not extension.
4. Sample representative diffs for each cluster.
5. Classify each cluster as `commit_now`, `separate_commit`, `defer_review`, or `no_commit_local_only`.
6. Never recommend `git add .`.

## Output

Produce a compact map with cluster, representative paths, observed diff pattern,
decision, and reason.

If remote/manual changes exist without repo artifacts, mark them `remote_only_drift`.
