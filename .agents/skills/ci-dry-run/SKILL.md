---
name: ci-dry-run
description: Optional Linux Docker diagnostic for package install, build, typecheck and tests.
---

# Linux Docker diagnostic

Contributor verification policy is owned only by
[AGENTS.md](../../../AGENTS.md#delivery-and-verification).
`tools/ci-dry-run.ps1` runs `npm ci`, package build/typecheck and, by default,
`npm test` in `node:22-alpine`. Its executable source owns the exact command set.

```powershell
pwsh tools/ci-dry-run.ps1 -Quick
pwsh tools/ci-dry-run.ps1
```

Docker must be available. `-Quick` skips tests; `-Snapshots` requests snapshot
updates and therefore produces a diff requiring review. Ordinary runs do not
request snapshot regeneration. `-KeepContainer` retains diagnostic state.

This is a local diagnostic, not final acceptance or CI equivalence: it does not
cover Windows, all workflows, live required-check producers, branch rules, or
trusted-base review. A green result covers only the commands and platform run.
Snapshot changes or later code fixes invalidate affected evidence under AGENTS.md.
