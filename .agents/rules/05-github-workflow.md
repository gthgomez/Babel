<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# GitHub Workflow

Read this rule when the user asks an agent to run the whole GitHub workflow, ship local work, create a branch, commit, push, or open a pull request.

This is the agent operating contract. Babel CLI support can later automate pieces of it, but the current authority is this workflow plus direct repo evidence.

## Default Interpretation

Treat `run the whole GitHub workflow` as the safe local-to-draft-PR path:

1. inspect repo identity, branch, remote, and dirty-tree inventory
2. sync remote metadata and identify the sanitized base
3. classify every visible path into a release batch or an explicit exclusion
4. build a release map and dependency-ordered PR stack
5. review each proposed batch against size and risk limits
6. verify the selected batch
7. stage only the selected paths
8. review the staged diff
9. create one focused commit
10. push a non-main branch
11. open a draft PR with stack context
12. report evidence, exclusions, and CI status when visible

When the worktree contains more than one coherent concern, the agent must stop
thinking about the entire tree as one change. It should produce a batch map first
and ship one batch at a time.

If the user specifically asks to monitor GitHub Actions, include CI follow-up after the PR is opened.

## Autonomy Contract

The managing agent may proceed without step-by-step approval when all of these are true:

- the work is inside the trusted workspace and current repo
- the intended batch is coherent and task-related
- no hard-stop condition is triggered
- required local verification passes or the user explicitly requested a draft despite known failures
- Git operations target a non-main branch
- PR creation is draft by default

The default review budget is at most 1,500 changed lines and 30 files per PR.
Exceeding either limit requires a semantic split or explicit user approval with
the reason recorded in the PR body.

The managing agent may autonomously:

- inspect `git status`, branches, remotes, logs, and diffs
- run safe local verification commands for the touched surface
- create or switch to a task branch
- stage only task-relevant files
- commit with a focused message after reviewing the staged diff
- push the task branch
- open a draft PR with summary, tests, risks, and excluded files

The managing agent must not merge, deploy, force push, reset, clean, delete branches, rewrite shared history, or push directly to `main`/`master` without explicit user approval.

## Repo Identity

This is the **canonical public source** of Babel (`gthgomez/Babel`). No separate private source repository is required to build or run. CI gates (security, public-content-policy, linux-validation, windows-portability) run on every PR and must pass before merge. Never skip or bypass CI gates.

## Manager And Subagents

When using multiple agents, the manager owns all Git mutation decisions.

Subagents may inspect, test, review, and report. They may propose patches only when their write scope is declared. They do not stage, commit, push, open PRs, merge, or deploy.

Useful subagent roles:

- diff-scope reviewer: checks whether changed files match the task
- risk reviewer: checks for secrets, generated artifacts, lockfiles, destructive changes, migrations, and config risk
- verification reviewer: checks whether the test/build evidence is enough
- PR reviewer: prepares or audits the PR title, body, risks, and follow-ups

Proceed only when the manager can reconcile subagent evidence. If reviewers disagree on risk or scope, stop and report the disagreement.

## Required Preflight

Before staging or committing:

```powershell
git fetch origin
git status --short --branch
git branch --show-current
git log --oneline --decorate -5
git diff --stat
```

Review the diff directly enough to understand scope and risk. Use targeted file reads for high-risk or surprising files.

## Dirty-Tree Triage

Before staging a non-clean tree, create a release map with one row per visible
path. Each row must have exactly one disposition:

| Disposition | Meaning | Default action |
|---|---|---|
| `ship` | Clearly belongs to the requested product slice | Assign to one batch |
| `split` | Related work that belongs in a later dependent PR | Assign to a later batch |
| `vault` | Internal audit, teardown, operator note, or private research | Copy to the vault; never stage publicly |
| `exclude` | Scratch, cache, generated data, local settings, or debug output | Leave unstaged and ignore when appropriate |
| `investigate` | Unclear ownership or unexplained content | Block until classified |
| `local-helper` | Machine-specific tooling outside the public product | Keep local unless separately approved |

Use path and diff evidence, not filenames alone. Sample at least one code file,
one documentation/tooling file, and one generated-looking file before deciding.
No path without a batch assignment may be staged.

Prefer these deterministic batch boundaries:

- provider behavior and provider tests;
- executor, evidence, and recovery behavior;
- protocol, daemon, and session behavior;
- public product docs;
- GitHub workflow and verification skills.

Preserve dependency order. If a historical commit is not independently
buildable, move it after the slice that supplies its interfaces or split out a
small compatibility change with its owning feature.

## Hard Stops

Stop and ask the user before proceeding if any of these are true:

- the release map contains `investigate` paths or a batch mixes unrelated concerns
- secrets, tokens, credentials, private keys, or `.env*` files appear in the diff
- the workflow would push directly to `main` or `master`
- required tests, typecheck, build, or validators fail
- destructive Git operations would be needed, including reset, clean, force push, rebase of shared work, stash drop, or branch deletion
- production deploys, database migrations, auth/security config changes, or infrastructure changes are involved
- lockfiles changed without dependency intent
- generated or build artifacts changed unexpectedly
- the staged set would combine unrelated concerns
- subagent reviewers disagree on safety, scope, or verification sufficiency

If the user explicitly asks for a draft PR despite a known failure, the PR body must name the failure and the final response must mark the work as not fully verified.

## Public CI Gating

This repo enforces 4 CI gates on every PR:

- **security**: gitleaks v8.30.1 (SHA-256 pinned) + public scrub check
- **public-content-policy**: 12 PCONT rules + canonical independence (4 CANON rules)
- **linux-validation**: typecheck + catalog validation
- **windows-portability**: all of the above on Windows

All gates must pass before merge. Run local equivalents before pushing:

```powershell
pwsh tools/check-public-content-policy.ps1 -RepoRoot .
pwsh tools/run-public-secret-scan.ps1 -RepoRoot . -Strict -RequireExternalScanner
cd babel-cli && npx tsc --noEmit
```

## Staging Contract

Before staging, identify:

- planned batch name and exact staging set
- intentionally excluded local files
- reason each excluded file is not part of the PR
- the next dependent batch, if any

Stage by explicit path whenever practical. Avoid blind `git add .`; use it only after the full dirty tree has been reviewed and every changed file is intended.

Never stage a path that is both staged and unstaged. Never stage unexplained
untracked directories. If the planned set contains an internal/public-policy
path, a secret-risk path, or a generated artifact, fail closed and restage.

Before committing, always inspect:

```powershell
git diff --staged --stat
git diff --staged
```

The staged diff must match the requested task and exclude unrelated local work.

## Verification

Use the smallest sufficient proof set for the touched surface, then expand when the change affects shared contracts.

For Babel CLI code changes, start with:

```powershell
npm --prefix .\babel-cli run typecheck
npm --prefix .\babel-cli run build
```

Add targeted tests or validators when touching tests, routing, catalog entries, prompt contracts, compiler behavior, schemas, generated memory tooling, or user-facing CLI behavior.

For doc-only changes, direct file inspection is enough unless links, generated docs, catalog references, or release/public surfaces are affected.

## PR Contract

Open draft PRs by default.

The PR body should include:

- summary
- tests or checks run
- risks and mitigations
- intentionally excluded files
- known failures or skipped verification
- follow-ups
- exact included batch and its parent/child PR relationship
- intentionally deferred batches from the release map
- changed-file and changed-line counts

After opening the PR, check visible CI status when available. Do not wait indefinitely unless the user asked for CI monitoring.

## Final Report

Report:

- branch
- commit hash
- PR link
- tests/checks run
- CI status if visible
- files staged
- files intentionally excluded
- remaining risks or hard stops

Keep observed facts separate from inference.
