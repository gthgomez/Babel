---
name: ship
description: Optional configured-workspace shipping adapter reference.
---

# Workspace shipping adapter

Contributor policy is owned only by [AGENTS.md](../../../AGENTS.md).
`ship-slice.ps1` is an optional workspace helper, not shipped by Babel. A request
to ship uses the repository delivery workflow whether or not this adapter exists.

For a configured installation, inspect its command mapping and dry-run output:
selected batch paths, checks, branch, commit, push destination, and draft PR.
Parameters such as `-NoDryRun` and `-Message` depend on the installed version.
Adapter flags cannot waive AGENTS.md's required checks or authorization. Its
review-size guidance does not impose a numeric publication blocker. A `bv`
invocation is not proof that all applicable checks ran; use the
recorded commands/results. No task-helper, quick/full/Docker sequence, or private
workspace configuration is a prerequisite for ordinary Babel delivery.
