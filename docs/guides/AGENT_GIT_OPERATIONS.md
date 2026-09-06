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

The command emits JSON with the repository, branch, local and base SHAs, Git and GitHub CLI paths, authentication result, credential-provider result, worktree state, and named readiness checks. Read its action-scoped fields: `localMutationAllowed`/`mutationReady` govern local work, while `remoteMutationAllowed`/`pushReady` govern remote work. Dirty state is reported for reconciliation and does not revoke local task authority. A GitHub or remote failure reports `STOP_REMOTE` while local edits, tests, and commits continue. `-AllowDirtyWorktree` remains a compatibility flag and is no longer required.

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

`preflight → reconcile dirty work → fetch when remote-ready → isolate only when useful/conflicting → modify → verify → review diff → commit → push → verify remote SHA → create/update PR → inspect exact-SHA CI → repair → revalidate → merge → fetch → verify main → post-merge checks`

Do not infer that green CI belongs to the current work. Bind review, the remote branch, the PR, and the check runs to the same commit SHA immediately before a merge.

## PR merge gate

After review and CI are available, run:

```powershell
.\scripts\agent-pr-gate.ps1 -PR 110 -ReviewedHeadSha <reviewed-sha> -RiskTier HIGH -IndependentReviewReceiptPath <receipt>

`-BootstrapRepairAuthorized` is reserved for the documented gate-repair self-gating transition and records its exception; it is not a general check bypass.
```

The result is either `MERGE_READY` or `BLOCKED` and includes the reviewed head, PR head, remote branch head, exact-head CI resolutions, PR base, current `origin/main`, active GitHub ruleset policy, independent technical review state, worktree state, and blockers. `MERGE_READY` means technical eligibility only; the repository gate neither authenticates nor creates task authority. Required status contexts are read from the active `protect-main` ruleset rather than assumed locally. HIGH and CRITICAL risk tiers require exact-head independent review evidence, and protected trust-root paths force the certified signing tier even if a caller supplies `-RiskTier LOW`. Normal checked merge is a routine transaction inherited from the trusted active shipping task; the legacy `-MergeAuthorized` switch is accepted for compatibility but does not create authority. Use `-AllowedPath` when an explicit changed-path allowlist is part of the review, and `-RequireIsolatedWorktree` when methodological validity requires isolation.

The gate uses `gh pr view` for PR metadata and the commit-scoped check-runs API for CI. It does not merge, delete branches, force-push, or rewrite history.

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
