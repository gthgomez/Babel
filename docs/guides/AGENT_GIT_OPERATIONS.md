<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-26
-->

# Babel Agent Git Operations

This guide defines the observable Git/GitHub operating environment for agents working in Babel’s public canonical repository (`gthgomez/Babel`). It is operational guidance; it does not change the `harness-v1` contract.

## Start with the readiness gate

Run this before modifying or staging work:

```powershell
.\scripts\agent-preflight.ps1
```

The command emits JSON with the repository, branch, local and base SHAs, Git and GitHub CLI paths, authentication result, credential-provider result, worktree state, and named readiness checks. It exits nonzero when a required check is blocked. Use `-AllowDirtyWorktree` only for inspection when an existing dirty tree is intentional; that mode does not make the tree mutation- or push-ready.

For a compact diagnostic snapshot that does not fetch or call GitHub:

```powershell
.\scripts\agent-git-status.ps1
```

The standard executable environment is the Git installation under `$env:ProgramFiles\Git\cmd\git.exe` and the `gh` executable resolved from PATH. The scripts set `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, and `GH_PROMPT_DISABLED=1` in their process so credential or editor prompts become explicit failures.

## Repository-local GitHub credentials

Babel keeps global Git Credential Manager configuration unchanged. The public checkout may isolate itself to GitHub CLI credentials with:

```powershell
$git = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
& $git config --local --unset-all credential.helper 2>$null
& $git config --local --add credential.helper ''
& $git config --local --add credential.helper '!gh auth git-credential'
```

Verify without exposing credential values:

```powershell
gh auth status --hostname github.com
& $git config --show-origin --get-all credential.helper
& $git ls-remote origin HEAD
```

The empty local helper entry resets inherited helpers for this repository, allowing the repo-local `gh` helper to take precedence. Never put tokens in prompts, remotes, `.env` files, scripts, logs, or commits. Never change global Git configuration, Windows Credential Manager, SSH configuration, stored GitHub credentials, or remotes to bypass an authentication failure.

## Isolate substantial work

Keep the canonical checkout available for coordination and use a linked worktree for substantial agent work:

```powershell
.\scripts\agent-worktree.ps1 -Action create -Name pr-110-review
```

The command fetches first, records the base SHA, creates a task directory below its default worktree root, and reports its branch, head, base SHA, and isolation state. It never removes an existing worktree. List registered worktrees with:

```powershell
.\scripts\agent-worktree.ps1 -Action list
```

Remove a worktree only after confirming its exact path and branch ownership:

```powershell
& (Join-Path $env:ProgramFiles 'Git\cmd\git.exe') worktree remove '<worktree-path>'
```

## Git and GitHub ownership

Use `git` for repository state and `gh` for GitHub state:

| Concern | Command family |
|---|---|
| status, fetch, diff, worktrees, add, commit, push | `git` |
| auth, repository metadata, PRs, reviews, checks, runs, merge | `gh` |

The normal lifecycle is:

`preflight → fetch → isolated worktree → modify → verify → review diff → commit → clean status → push → verify remote SHA → create/update PR → inspect exact-SHA CI → revalidate → merge → fetch → verify main → post-merge checks`

Do not infer that green CI belongs to the current work. Bind review, the remote branch, the PR, and the check runs to the same commit SHA immediately before a merge.

## PR merge gate

After review and CI are available, evaluate the exact reviewed head with the base-rooted gate:

```powershell
.\scripts\agent-pr-gate.ps1 -PR 110 -ReviewedHeadSha <reviewed-sha> -RiskTier HIGH
```

The result is either `MERGE_READY` or `BLOCKED` and includes the reviewed head, PR head, remote branch head, exact-head CI resolutions, PR base, current `origin/main`, active GitHub ruleset policy, independent technical review state, task-authorization state, worktree state, and blockers. Required status contexts are read from the active `protect-main` ruleset rather than assumed locally. HIGH and CRITICAL risk tiers require exact-head independent review evidence: `-AutonomousReviewEvidencePath` supplies a locally built evidence file and `-BuilderIdentity` sets the builder identity that the reviewer must differ from. Use `-AllowedPath` when an explicit changed-path allowlist is part of the review, and `-RequireIsolatedWorktree` when the gate must reject a canonical checkout. There is no per-merge authorization switch: the current task authorizes routine Git/PR actions and the gate records `taskAuthorization` from the dispatch scope.

When the gate reports `MERGE_READY` for the exact reviewed head, merge through the bounded executor:

```powershell
.\scripts\agent-pr-merge.ps1 -PR 110 -ReviewedHeadSha <reviewed-sha> -RepoRoot <clone>
```

The executor re-runs the base-rooted gate (`scripts/trusted-merge-gate.ps1`, materialized from the immutable base), accepts only a `MERGE_READY` whose reviewed head, PR head, remote branch head, and CI head all equal `-ReviewedHeadSha`, re-reads live PR state, and then runs `gh pr merge 110 --match-head-commit <reviewed-sha> --squash`. It derives `-BaseSha` from `gh pr view --json baseRefOid` when omitted and refuses an unattested base. It fails closed with a `BLOCKED` JSON result and a non-zero exit on any mismatch and never retries with a different SHA. It is an executor, not a merge authority: the gate does not merge, and the executor cannot merge without a gate `MERGE_READY` for that exact head. Neither tool deletes branches, force-pushes, or rewrites history.

## Review evidence transport

HIGH and CRITICAL tier PRs that do not modify protected trust-root paths satisfy the gate's independent-review check with `autonomous_review_evidence_v1` evidence bound to the exact base, head, and diff digest. Build, validate, and post it with the dedicated tool instead of hand-writing the JSON:

```powershell
.\scripts\agent-pr-evidence.ps1 -PR 147 -ReviewerId <isolated-reviewer-id> `
  -Scope @('Full diff <base>...<head> (…): <files>') [-Findings @('…')] `
  [-Retrigger]
```

The tool derives the repository and PR base/head from live state, computes the numstat digest with the gate's own module, runs the gate-identical validator before posting (failing closed on any error, including blocking findings, a non-`APPROVE` verdict, or a reviewer matching the builder identity), posts the marker-delimited comment the evidence transport expects, keeps the same-head case idempotent (identical bodies skip; differing bodies refuse rather than create ambiguity), and with `-Retrigger` performs the evidence → close/reopen sequence so a fresh `pull_request_target` run re-materializes evidence at execution time (mark the PR ready first; the tool refuses to transport evidence for a draft). Use `-WhatIfOnly -OutFile <file>` to build and validate offline. Setting the repository variable `BABEL_REQUIRE_SIGNED_REVIEW=1` overrides the autonomous tier for all PRs and requires the signed CERTIFIED receipt instead. After #144's comment-triggered re-evaluation merges, `-Retrigger` becomes a fallback rather than the normal lifecycle.

## Troubleshooting hangs

If `gh auth status` succeeds but `git push` hangs, Git may be invoking an inherited credential helper such as Git Credential Manager before the GitHub CLI helper. Inspect the repo-local helper state and apply the repository-local reset above. Keep the global helper intact for other repositories. With noninteractive defaults enabled, an unresolved credential or editor problem should fail with a command result rather than waiting for input.
