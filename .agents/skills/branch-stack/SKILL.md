---
name: branch-stack
description: Reference for organizing dependent branch reviews with explicit parent/base relationships.
---

# Branch stack reference

Contributor policy is owned only by [AGENTS.md](../../../AGENTS.md).
This repository does not ship an automated stack manager. A stack can be recorded
in the existing task/PR handoff as branch, direct base, parent PR and child PR.
`git log --graph --oneline --all` and `gh pr view --json baseRefName,headRefName`
provide topology evidence. No stack metadata file is required.

Parent-targeted PRs help organize dependent review. Their review diff is against
the direct parent; final merge readiness is against current main after dependencies
land and the candidate is reconstructed or synchronized within authorized Git
operations. A parent review does not certify a later main-targeted candidate.
There is no automatic rebase, force-push, branch deletion, or bottom-up merge
command. Git mutation and final exact-head checks follow AGENTS.md.
