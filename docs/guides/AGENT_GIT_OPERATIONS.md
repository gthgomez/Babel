<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-10-07
-->

# Babel Agent Git Operations

This non-authoritative technical reference describes Git/GitHub helper inputs
and outputs. [AGENTS.md](../../AGENTS.md) alone owns contributor operating policy;
examples here do not grant authorization. The scripts own executable behavior.

## Fresh agent entry sequence

1. Read [AGENTS.md](../../AGENTS.md) and copy the [batch handoff template](./AGENT_BATCH_HANDOFF.md) into your task record.
2. `git fetch origin main` and confirm no conflicting open PR or duplicate writer on your branch.
3. Run Git preflight (below) with explicit `-GitPath` / `-GhPath` on non-Windows hosts.
4. Classify the batch (product / test / environment / authority) before editing.
5. Run stage-appropriate qualification (implementation vs maintainer pre-merge); see [Batch dispatch reference](#batch-dispatch-reference) for canonical CLI commands and known early failures.
6. One qualified publication per coherent batch; merge only through `scripts/trusted-merge-gate.ps1` then `scripts/agent-pr-merge.ps1` when authorized.

Optional V3 or signed review publication is not mandatory setup for contributors. Actual independent exact-head review remains required; the live gate treats custom review evidence as advisory unless separately governed.

## Batch dispatch reference

Copy the [batch handoff template](./AGENT_BATCH_HANDOFF.md) table into your private task record; that page is layout only. This section holds the explanatory detail AGENTS.md omits for interactive prompt budget.

**Product proof:** `npm --prefix babel-cli run typecheck` covers source and `tsconfig.scripts.json` (scripts-only drift). `qualify:build` runs both in one maintainer-oriented pass; ordinary `typecheck` remains the default while editing.

**Maintainer supplemental scrub:** validate JSON with `tools/check-public-scrub.ps1 -RequireSupplementalPolicy`. Optional readable-path preflight only: `-CheckSupplementalScrubPolicyPath` on `scripts/agent-preflight.ps1` (default preflight unchanged; path check does not replace scrub validation).

**Execution vs planning:** `agent-preflight.ps1` is planning/readiness only. Cheap execution reuses `validate-push-candidates.mjs` (`--staged-manifest`, push preflight); `verify-changed-publication-surface.mjs` reports configured hook ownership (`repo:.githooks` / `host-managed` / `unset`) with execution unverified, runs cheap checks, and (for `--candidate` equal to current `HEAD`) branch frontier before success. Full publication scans stay in [REVIEW_MARKERS.md](./REVIEW_MARKERS.md). Do not swap host hook dispatchers; install `.githooks` only when authorized.

| Symptom | Where to look |
| --- | --- |
| Scripts-only type errors | `npm --prefix babel-cli run typecheck` (both tsconfigs) |
| Windows npm EINVAL in tests | `process.execPath` + `npm_execpath`; hosted `windows-portability` |
| Trusted boundary vs candidate triggers | Base-owned test on main; may need a main PR, not candidate-only |
| Maintainer scrub “not configured” | `BABEL_PRIVATE_SCRUB_POLICY_PATH` + `check-public-scrub.ps1 -RequireSupplementalPolicy` |
| V3/signing confusion | Optional publication; AGENTS + live gate advisory mode for custom evidence |
| Missing Node/PowerShell/Gitleaks at dispatch | `node --version`, `pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`, `gitleaks version` (or hosted job pending) |
| Packaged worker/asset drift | `babel-cli/package.json` `files` / worker entries; consumer or package jobs when packaging changes |

**Before dispatch (existing commands only):** `node --version`, `pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`, `gh auth status` — no new installer framework. Search authorized branches/remotes for referenced paths before asking the user; configure `BABEL_PRIVATE_SCRUB_POLICY_PATH` off-repo; validate content with `tools/check-public-scrub.ps1 -RequireSupplementalPolicy`, not preflight alone. `git fetch origin <branch>` and compare `origin/<branch>` to local HEAD before amending or rewriting.

**Publication (truthful procedure):** local commits are checkpoints, not proof of a single remote publication. After any remote branch exists, prefer additive commits and a normal `git push`; do not amend or force-push without explicit owner authority. `--force-with-lease` binds to an expected remote SHA; it is not merge authority and does not erase prior remote heads from history. When a branch advanced through more than one remote tip, record the sequence in your private task record, not in public docs.

**Handoff footer:** changed/excluded paths; commands + exit results; reuse basis; blocker + stage; next owner/action.

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

Optional maintainer pre-merge path diagnostic (default unchanged; does not validate policy JSON—use `tools/check-public-scrub.ps1 -RequireSupplementalPolicy` for that):

```powershell
$env:BABEL_PRIVATE_SCRUB_POLICY_PATH = 'C:\path\outside\repo\policy.json'
.\scripts\agent-preflight.ps1 -CheckSupplementalScrubPolicyPath
```

The command emits JSON with the repository, branch, local and base SHAs, Git and GitHub CLI paths, authentication result, credential-provider result, worktree state, and named readiness checks. It exits nonzero when a required check is blocked. Use `-AllowDirtyWorktree` only for inspection when an existing dirty tree is intentional; that mode does not make the tree mutation- or push-ready.

This diagnostic performs read-only Git and GitHub queries. If local remote refs
are stale it reports `remote_base_stale_fetch_required`; fetch once in a separate
Git operation and retry the affected diagnostic. AGENTS.md determines when its
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
Check and workflow lists are paginated; mutable workflow state and latest
attempts are read live. Validated immutable job/attempt bindings can be reused
within one invocation. Waiting and final evaluation use the same authoritative
producer resolver. Foreign checks and older pending attempts cannot delay a
newer authoritative success; newer authoritative pending work cannot be
hidden by an older success.

The default diagnostic takes one snapshot without sleeping. Set
`-CheckWaitSeconds <0..1800>` for an explicit wait; polling backs off to at most
one minute, and API requests remain bounded. Review threads, risk, approvals and
remote identity are checked before waiting. Terminal failures, missing workflows
and superseded candidates return early. The existing `workflow_run` listener
reconciles completed product checks. Final evaluation still reads current
identity and authoritative results; a successful request is not a passing check.

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

Read hook configuration and implementation once per unchanged revision. An owned
long-running check should retain its process/session handle, complete logs,
producer exit status and stage progress. Continue independent affordable work;
resume that operation instead of restarting it. Diagnose the failed stage before
retrying, and rerun checks whose inputs the repair actually invalidates.

Use `npm --prefix babel-cli run check:dependencies` to detect installed version
drift without reinstalling. Use `qualify:build` for one emitting source typecheck
plus the scripts typecheck; the ordinary `typecheck` command remains useful while
editing. `test:audit-integration` owns the real catalog and parity benchmark
execution separately from focused unit fixtures. CI runs it in the shorter
package-components job after a fresh CLI build, alongside platform qualification.
Required TAP runners stream
progress and retain stdout, stderr, selection and execution records.

Unit shards use content-bound OS duration hints in
`babel-cli/config/ci-unit-durations.json`. Refresh those hints with
`node babel-cli/scripts/update_ci_unit_durations.mjs <execution.json> [...]`
from completed unit artifacts. Hints change scheduling only; unknown, changed or
invalid entries fall back to deterministic weights and cannot omit a file.
Dedicated suites with different setup remain distinct qualification inputs;
filename overlap alone is insufficient evidence for removing them.
The portable workflow file is owned by the canonical unit inventory; `npm test`
does not invoke it a second time. Its focused script remains available.

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
