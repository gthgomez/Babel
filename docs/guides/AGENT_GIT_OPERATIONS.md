<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-10-07
-->

# Babel Agent Git Operations

This non-authoritative technical reference describes Git/GitHub helper inputs
and outputs. [AGENTS.md](../../AGENTS.md) alone owns contributor operating policy;
examples here do not grant authorization. The scripts own executable behavior.

## Readiness diagnostics

Readiness diagnostic:

```powershell
.\scripts\agent-preflight.ps1
```

The command emits JSON with the repository, branch, local and base SHAs, Git and GitHub CLI paths, authentication result, credential-provider result, worktree state, and named readiness checks. It exits nonzero when a required check is blocked. Use `-AllowDirtyWorktree` only for inspection when an existing dirty tree is intentional; that mode does not make the tree mutation- or push-ready.

This diagnostic includes a fetch and GitHub reads. AGENTS.md determines when its
evidence needs refreshing; invoking another wrapper or staging unchanged inputs
does not itself require repeating it. Its readiness verdict describes delivery
state, not authority to continue local engineering.

For a compact diagnostic snapshot that does not fetch or call GitHub:

```powershell
.\scripts\agent-git-status.ps1
```

Some helpers default to Windows Git under `$env:ProgramFiles\Git\cmd\git.exe`;
use explicit `-GitPath` and `-GhPath` for another host. The scripts set `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, and `GH_PROMPT_DISABLED=1` in their process so credential or editor prompts become explicit failures.

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

## PR merge gate

After verification, run:

```powershell
.\scripts\agent-pr-gate.ps1 -PR 110 -ReviewedHeadSha <verified-sha> -RiskTier HIGH
```

The result is `MERGE_READY` or `BLOCKED`, with exact head/base, current remote
state, live GitHub ruleset, required check producer/conclusion, thread resolution
and optional review diagnostics. The gate reads policy from GitHub; it does not
grant merge permission. The actual merging account must have permission and
current task authorization. Use an expected-head merge; never use admin bypass.

The trusted launcher materializes the gate and its evidence modules from the
immutable execution base. `sha.trustedPolicySha` records that base separately
from the candidate head. `-ExpectedExecutionBaseSha` binds direct diagnostic
invocations; the launcher supplies it automatically. Head or base movement,
closed/draft PRs and uncertain mergeability invalidate readiness. Identity is
checked before polling, during polling and again before the verdict.

`ciEvidence` distinguishes complete, failed, queued, running, waiting,
workflow-not-observed and source-unavailable states. A waiting workflow does
not by itself establish a pending approval. API denial, rate limiting,
malformed responses or incomplete pagination remain unavailable evidence.
Check and workflow lists are paginated; workflow metadata is cached only
within one snapshot. Waiting and final evaluation use the same authoritative
producer resolver. Foreign checks and older pending attempts cannot delay a
newer authoritative success; newer authoritative pending work cannot be
hidden by an older success.

The diagnostic wait has a 120-second wall-clock budget, with each API request
bounded by the remaining budget and a 15-second maximum. It exits promptly for
terminal failures, missing workflows, waiting workflows and superseded
candidates. A later successful peer run can leave this advisory audit stale;
it does not change GitHub's required check conclusions. Ordinary comments no
longer trigger cancellation or reruns. Completion-driven reconciliation is
deferred by the owner; the bounded diagnostic audit remains the selected path.

For missing Release Gate checks, first inspect the current PR head, subscribed
workflow state, run queue and approval state. Preserve the existing recovery
owner's event history; do not repeat trigger probes. A dispatch success is not
equivalent to the required `pull_request` producer. Reconcile an old audit only
when its recorded head and execution base still match. Required producer
names, GitHub application binding and the protected-main rules remain intact.

Human-readable review summaries from `tools/post-ai-review.ps1` are prose.
Controller V3 publication uses the canonical serializer and the real consumer
validator. Legacy V2 payloads are not promoted into certification by changing
their marker or schema number. Runtime-owned proof and exact-candidate review
requirements still apply.

## Required CI coverage evidence

The required aggregate jobs include policy integrity, PR metadata fixtures,
desktop tests on Windows and Linux, and separate native-ripgrep qualification
and forced fallback tests. Non-PR metadata qualification records explicit
non-applicability. Desktop discovery checks its independent six-file floor
before running the test glob.

Unit shards retain their exhaustive modulo assignment. Required TAP summaries
reject TODOs, truncated runs, unexplained skips and empty/all-skipped runs.
Suite-level SKIP/TODO directives and suite failures also reject qualification,
even when the leaf counters show a passing test. Zero-byte discovered unit
files fail selection before execution.
Selection and execution sidecars bind each completed source file to its hash,
package scripts and runtime. Native ripgrep is pinned and hash-verified; a
missing native binary fails qualification instead of silently passing.

Skipped leaves must also match the closed source/test/platform/suite/reason
inventory in `babel-cli/scripts/required_skip_policy.json`. Execution sidecars
record their source hashes; summaries report the applied rule and policy hash.
Local missing-Git or missing-base exceptions cannot satisfy hosted qualification,
and optional unit-lane ripgrep exclusions cannot satisfy the native lane. Older
TAP-only reports with skips need the new execution sidecar before they can pass.

Obsolete `daily`/`undo` benchmark scenarios map to current invariant tests:

| Previous invariant | Current required source and case |
|---|---|
| Natural-language usability | `liteUsability.test.ts`: every former daily natural-language scenario reaches current Chat with its task intact |
| Green verification before completion | `completionGatePolicy.test.ts`: current authoritative receipts; failed, missing and stale receipts remain rejected |
| Real mutation and rollback | `governedMutations.lock.test.ts`: failed mutation rolls back the project-root file and releases its lock |
| Failure and recovery after a real effect | `chatEngine.lifecycleQualification.test.ts`: crash after an effect is reconciled on restart without duplicate execution |

These retain behavioral invariants; they do not claim end-to-end equivalence
for retired benchmark command wrappers. Platform and unauthorized live-provider
limitations remain visible as skips. Local snapshot qualification must remove
ambient `NO_COLOR` as well as setting `FORCE_COLOR=1`, matching the CI steps.

The original Ubuntu review-contract commands remain in required platform-core
coverage; only the proven duplicate standalone job is removed. Shard
rebalancing and further suite deduplication require repeated comparable
timings and coverage/loader equivalence before adoption.

## Troubleshooting hangs

If `gh auth status` succeeds but `git push` hangs, Git may be invoking an inherited credential helper such as Git Credential Manager before the GitHub CLI helper. Inspect the repo-local helper state; any configuration change follows AGENTS.md authorization. Keep the global helper intact for other repositories. With noninteractive defaults enabled, an unresolved credential or editor problem should fail with a command result rather than waiting for input.

## Evidence migration notes

`ciEvidence` is additive to gate schema 4. Consumers should use its source
availability, workflow state and wait reason instead of interpreting an empty
check list as an observed missing run. A malformed current-main response is
`base_source_unavailable`; it cannot establish a current base. Audit-only draft
checks stop before peer reads; non-audit diagnostics retain the final snapshot
but perform zero wait attempts and remain blocked by the draft prerequisite.

Required TAP schema 2 now needs schema-1 selection and execution sidecars,
including source hashes, runtime and the closed skip inventory. Historical
TAP-only reports with skips cannot establish current qualification. Suite
SKIP/TODO/setup failures produce `unreviewed_suite_skip`, `todo_tests`, or
`failed_suite`; complete positive leaf counters do not override those errors.
Archived failures retain their original results before any stronger-parser
replay. A changed source, package command, runtime, head or execution base needs
new applicable evidence.
