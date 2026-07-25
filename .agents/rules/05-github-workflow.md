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

1. inspect repo state
2. sync remote metadata
3. review local and base diffs
4. verify the touched surface
5. stage intentionally
6. review the staged diff
7. create a focused commit
8. push a non-main branch
9. open a draft PR
10. report evidence and CI status when visible

If the user specifically asks to monitor GitHub Actions, include CI follow-up after the PR is opened.

## Autonomy Contract

The managing agent may proceed without step-by-step approval when all of these are true:

- the work is inside the trusted workspace and current repo
- the intended file set is coherent and task-related
- no hard-stop condition is triggered
- required local verification passes or the user explicitly requested a draft despite known failures
- Git operations target a non-main branch
- PR creation is draft by default

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

This is the **canonical public source** of Babel (`gthgomez/Babel`). There is no private parent repo required to build or run. CI gates (security, public-content-policy, linux-validation, windows-portability) run on every PR and must pass before merge. Never skip or bypass CI gates.

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

## Hard Stops

Stop and ask the user before proceeding if any of these are true:

- unrelated user edits are mixed into the worktree
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

- planned staging set
- intentionally excluded local files
- reason each excluded file is not part of the PR

Stage by explicit path whenever practical. Avoid blind `git add .`; use it only after the full dirty tree has been reviewed and every changed file is intended.

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
