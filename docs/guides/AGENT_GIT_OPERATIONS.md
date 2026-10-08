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

## CI campaign evidence ledger — 7 October 2026

This is a qualification ledger for the implementation campaign. The packets
below are draft PRs; code delivery does not establish integration, hosted
success, independent review, or distribution authorization. Local verification
uses Windows and Node 24.19.0 unless another environment is explicitly named.
Each PR's Files view records its exact owned paths and reversible direct-base
patch. Revert dependent packets before their prerequisites.

The observed baseline is main `4d3f43ba17d857b2f36c5f3f034e96f6b25ba48f`
and [failed run 37614742854](https://github.com/gthgomez/Babel/actions/runs/37614742854).
The active strict required checks are `security`, `public-content-policy`,
`linux-validation`, `public-pr-metadata`, and `windows-portability`, bound to
GitHub Actions app 15368. Trusted Control Plane is advisory. Recheck live
head/base, rules and latest authoritative attempts before any merge decision.
PR317 containment and PR318 installer cleanup/recovery retain their existing
owners; this campaign did not trigger, reopen or rerun those PRs.

| Packet / direct base | Exact commit and owned diff | Local evidence |
|---|---|---|
| Hooks / main | [#319](https://github.com/gthgomez/Babel/pull/319/files), `00eb14c970a19b8dbf17c360b3b776fa4bc62838` | Synthetic redaction/push-ref regressions; committed exports and redacted secret scan passed |
| Gate / #319 | [#320](https://github.com/gthgomez/Babel/pull/320/files), `69d6ca3c9e91d8e634f1f2f607edb593f833bf77` | Producer selection, pagination/cache, bounded-clock, candidate drift and immutable-launcher fixtures passed |
| Review transport / #320 | [#321](https://github.com/gthgomez/Babel/pull/321/files), `3f72794db08147a172f3a1d571f9e6ee9cf99a4e` | Eight canonical V3 round-trip cases and prose formatter case passed |
| Fixture migration / #321 | [#322](https://github.com/gthgomez/Babel/pull/322/files), `beec215386b1baa9428271322f89ee08f4ce7e3a` | 501 targeted tests: 472 passed, 29 explicit policy skips, no failures; 821.57 seconds |
| Required coverage / #322 | [#323](https://github.com/gthgomez/Babel/pull/323/files), `ab2ff510a782d051a008b9be934f6dd8ccf2f195` | Desktop 29/29; graph 34/34; real architectural-budget check and both typecheck configurations passed |
| Native/TAP / #323 | [#324](https://github.com/gthgomez/Babel/pull/324/files), `ded66e984035e9adc1945789dac8765c0d42a592` | Real pinned native lane 18/18 and forced fallback 8/8; all six native wrapper cases executed, no skips |
| Pure contracts / #324 | [#325](https://github.com/gthgomez/Babel/pull/325/files), `29f7c7c5c31cb1ebb75a9382f068b6dccb28e37f` | Two existing pure comparison contracts: 22/22 offline; classification/sharding fixtures 11/11 |
| Review duplicate / #325 | [#326](https://github.com/gthgomez/Babel/pull/326/files), `922de47b02abe5a2218db0a2343752e38f9ec9d8` | Original Ubuntu three-PS/eleven-TS required command union retained; graph fixtures 34/34 |
| Suite directives / #326 | [#327](https://github.com/gthgomez/Babel/pull/327/files), `be98e5d43c3be73561363ecbe7247c0985b3f080` | Actual Node suite SKIP/TODO/setup-failure counterexamples reject; seven tooling and sixteen summary regressions passed |
| Consumer archive / #327 | [#328](https://github.com/gthgomez/Babel/pull/328/files), `2315f27844abe3614d2ae05c9d92a730d4217955` | Fourteen archive/environment/dist/graph/common-pack fixtures passed; 37 coverage fixtures plus corrected-environment asset-packaging rerun passed |
| Release identity / #328 | [#329](https://github.com/gthgomez/Babel/pull/329/files), `114723972cfbb2f894503a1aa7ca542af2a71b4a` | Thirty-three identity/BUILD/workflow/source-provenance/manifest fixtures passed; no real publication |

Every packet's committed-candidate pre-push validation passed. These local
checks do not certify the full integrated test graph. Exact PR317 archived
source separately passed five containment cases. Exact PR318 archived source
passed 34 desktop tests, and five compiler/archive-cleanup mutations were
caught by its real test command; those results do not describe main's 29-case
source. No duplicate implementation of their owned repair was introduced.

| Finding | Disposition and evidence |
|---|---|
| F1 | Bounded diagnostic audit implemented in #320; completion listener deferred by owner decision |
| F2–F6 | One authoritative resolver, explicit unavailable/workflow states, comment subscription removal, exact execution-base binding and paginated cached snapshots in #320 |
| F7 | Metadata-only hook diagnostics and actual pushed-object validation in #319 |
| F8 | Exact stable annotated tag identity and movement checks in #329 |
| F9 | Prose versus certification clarified in #321 and this guide; existing trusted-base review policy remains authoritative |
| F10 | Independent desktop discovery and unique integrity/metadata dependencies in #323; protected registration consistency retained |
| F11 | Pinned native execution and required TAP/file/skip evidence in #324; suite-directive counterexample repaired in #327 |
| F12 | PR317/318 repairs independently qualified; uncovered alias and process-lifecycle fixtures in #322; recovery ownership preserved |
| F13 | Controlled consumer homes/config/npm/preloads/provider/credential variables in #328; synthetic inherited canaries passed |
| F14 | Only the proven standalone review-contract duplicate removed in #326; further deduplication and weighted sharding deferred |
| F15 | Existing cross-platform aggregate obligations retained; platform-local summaries deferred pending equivalence and timing evidence |
| F16 | One archive feeds all nine consumers; all nine build contracts retained in #328; cross-run release byte equality remains unproven |
| F17 | Common validation/pack, content drift checks and deterministic portable evidence in #328–329; actual build/consumer/publication qualification remains separate |
| F18 | Existing pure offline contracts restored to unit selection in #325; current invariant mapping and canonical release instructions updated |

| Acceptance cases | Evidence / remaining limit |
|---|---|
| R01–R12 | #320 resolver, snapshot, clock, identity and immutable-launcher fixtures; hosted current-candidate qualification remains required |
| R13 | Trusted-base boundary fixtures retained; custom review evidence remains advisory; fresh independent review pending |
| R14–R15 | Comment refresh removed; actual V3 consumer round-trip and blocking/malformed cases in #320–321 |
| R16–R18 | Not applicable: optional completion listener remains deferred |
| R19 | Reuse only exact-input authoritative evidence; existing recovery owner's event history remains untouched |
| R20 | Desktop floor/dual-OS commands and applicable unique policy/metadata dependencies in #323 |
| R21 | All six real native cases executed locally; absent/wrong executable and workflow omissions rejected; fallback separately passed |
| R22 | Required footer, file sidecars, closed skip inventory and suite directives reject inadequate coverage; raw failing runs retained |
| R23–R24 | Required review command union proven; original 777-file unit/specialized union retained through #325; pure offline contracts active |
| R25–R26 | Synthetic secret/scanner and initial/multi/non-HEAD/tag/deletion push fixtures in #319 |
| R27 | Exact PR317/318 qualification and five actual PR318 cleanup mutations; process lifecycle regressions in #322 |
| R28 | Consumer inherited setting canaries and controlled configuration in #328 |
| R29–R30 | Exact-tag and wrong-source/movement/BUILD-digest fixtures in #329 |
| R31 | Same-version replaced archive rejects; nine-row graph retained; all nine hosted consumer and nine retained build rows passed at the exact #328 head; later candidates need applicable fresh evidence |
| R32–R33 | Unique BUILD evidence, common provenance rejection, ignored-dist drift and early preview rejection fixtures passed; publication/OIDC unverified |

The first integrated unit attempt remains FAILED: 9,362 reported tests,
9,304 passed, one failed and 57 reviewed skips. Shards 1 and 2 completed;
shard 0 failed a synthesis assertion, and shard 3's runner succeeded but its
TAP sequence was invalid. A whole-file ChatEngine diagnostic then observed a
10-second quick-inspect wall cutoff before a synthesis assertion. Giving only
the two synthesis fixtures an explicit 120-second allowance preserved their
assertions and passed all twelve cases in 42.505 seconds. The original shard-0
failure's precise cause remains inferred; its raw result is retained.

The sole zero-byte `src/cli/helpers.test.ts` emitted a synthetic file result
numbered 57 between root results 212 and 214. Both hosted operating systems
reproduced that malformed sequence. Removing this empty file drops no
behavioral invariant: the revised union is 757 unit plus 19 specialized files.
Discovery now rejects zero-byte files. Modulo assignments shift, so the new
required run must be qualified; old green shard reports are not a current
whole-suite result.

At the recorded hosted snapshot, #319 had five green protected checks.
#320–327 had red platform aggregates; #328 had three green protected checks
with aggregate evidence pending in that snapshot; its completed run later
reported both aggregates failed. It additionally exposed a Linux service
timeout descendant-PID assertion. The process state and ability to execute
were not established; diagnostics now record only the validated owned
Linux PID state, preserving the immediate assertion and late-write check. Windows platform-core exposed a stale
readiness fixture missing current-main/pagination/workflow API shapes. A
Windows harness setup also timed out during its real private-directory ACL
verification; that cause remains UNKNOWN and ACL enforcement was preserved.
Fresh independent reviews and integration are pending, with no subagents
started while measured free RAM was below the owner-selected 3 GiB minimum.

Clean common packaging initially exhausted the local 768 MiB and 1.25 GiB
heap limits during compilation; both failures are retained. No successful
archive or installed-product qualification is inferred from tooling fixtures.
Hosted [run 37716134106](https://github.com/gthgomez/Babel/actions/runs/37716134106)
provides separate actual evidence: one successful Ubuntu Node 22.19.0 producer
and all nine consumer plus nine retained build rows at exact #328 source
`2315f27844abe3614d2ae05c9d92a730d4217955`. After download, the tarball matched
the independently logged consumer-step expected source and SHA256
`18cd36bb06573a2d1b8247de79cffb28810aca99426c2e6aaae4353a8932330c`;
its 1,286-file inventory passed the consumer allowlist. Producer job
113112890517 took 75 seconds including setup. The overall run remains failed,
and this single timing sample does not measure an improvement.
Baseline runner durations come from one failed run, not a bill or a measured
post-change improvement. No elapsed-time, cost, or queue-delay saving is claimed.
Native startup and an earlier offline-parity timeout also remain recorded;
successful targeted reruns do not erase those limits. Unsupported preview
channels and source-release eligibility remain deferred design decisions,
and neither a draft PR nor a dry run qualifies registry write access.
