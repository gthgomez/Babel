<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-26
-->

# Babel Agent Git Operations

This non-authoritative technical reference describes Git/GitHub helper inputs
and outputs. [AGENTS.md](../../AGENTS.md) alone owns contributor operating policy;
examples here do not grant authorization. The scripts own executable behavior.

## Resource-aware iteration

Apply [AGENTS.md](../../AGENTS.md) on the machine running the tools. Inspect available physical memory and effective CPU capacity, including container/VM/job and parent limits; retain reserve for the coordinator, OS, background work, and uncertainty. Swap is not spare capacity. Use recent observed peak incremental costs from comparable required runs, including child processes and nested pools. Account for pending reservations and expected growth without subtracting usage already reflected in available memory twice. Unknown expensive work starts with one conservative useful run, not an extra benchmark.

Hosted reasoning slots, model context/spend, and local process RAM/CPU/I/O are different budgets. More RAM can permit more memory-heavy jobs when CPU/I/O also fit; it cannot raise a hard runtime agent ceiling. Allow independent light reads or hosted reviews alongside heavy jobs when their own budgets fit. Coordinate heavy admissions across agents; an agent slot does not grant an unbudgeted build slot. Queue CPU-heavy validators under sustained pressure even on a RAM-rich host. Re-sample cheaply before new heavy admissions and after completions; back off on shrinking headroom, new swap/OOM events, or slower comparable work. Preserve unrelated processes and keep increased concurrency only when it improves correct end-to-end delivery.

Read batches bound repository/path scope, total command count, in-flight concurrency, and output size. Reuse comparable batch bounds; label and inspect every result and failure before dependent follow-ups. Keep consistency-sensitive reads outside mutations. Shared Git mutations stay serialized with separate observation boundaries, regardless of hardware.

Reuse evidence only under AGENTS.md's unchanged-input rules and required commands. Freeze source before final scans, reuse packaging's required build, deduplicate completed failure logs, and qualify shared repairs before propagation. Keep evidence outside public Git; prioritize the work that unblocks the next delivery. These portable instructions are maintained in Babel and workspace-root; either repository must remain usable without the other checkout. Never commit a device's resource snapshot or machine-specific paths as policy.

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

## Troubleshooting hangs

If `gh auth status` succeeds but `git push` hangs, Git may be invoking an inherited credential helper such as Git Credential Manager before the GitHub CLI helper. Inspect the repo-local helper state; any configuration change follows AGENTS.md authorization. Keep the global helper intact for other repositories. With noninteractive defaults enabled, an unresolved credential or editor problem should fail with a command result rather than waiting for input.
