<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-25
-->

# Babel Debugging Nervous System — B0 Inventory

This document is the B0 inventory for the Debugging Nervous System (BDNS).
It records the live boundaries that the later slices observe. It does not
make any existing subsystem subordinate to BDNS and it does not authorize
filesystem or process surveillance outside the boundaries listed here.

## Existing evidence planes

| Plane | Source of facts | Purpose | Trust boundary | Retention / failure mode |
| --- | --- | --- | --- | --- |
| Canonical session events | `babel-cli/src/agent/sessionEvents.ts` | Durable model/tool/policy lifecycle | Canonical semantic lifecycle for Babel | JSONL in the run directory; strict flush can fail the owning durability path |
| Episode stream | `babel-cli/src/evidence/episodeStream.ts` | Evidence projection and replay | Derived from canonical events | Run evidence; validation reports malformed or incomplete streams |
| EvidenceGraph | `babel-cli/src/evidence/evidenceGraph.ts` | Claims, patches, verifier receipts, and revision links | Verification/evidence authority; not an execution oracle | In-memory graph plus run artifacts |
| Workspace transactions | `babel-cli/src/services/workspaceTransactions.ts` | Pre/post images, hashes, changed bytes, undo | Strong for declared file-write batches | Session-scoped latest receipt; I/O errors propagate to the mutation caller |
| Trace auditor | `babel-cli/src/services/traceAuditor/traceAuditor.ts` | Cross-stream ordering and lifecycle audit | Independent audit of recorded streams | Offline audit artifacts; malformed input is reported, not normalized |
| Terminal/TUI observation | `babel-cli/src/ui/observe/` | Visible terminal frames and semantic UI projection | Presentation witness only; never semantic truth | Opt-in TUI session store with byte budget and cleanup |
| OTel | `babel-cli/src/telemetry/tracing.ts` | Optional trace/span correlation | External correlation enrichment only | Disabled by default; unavailable exporters must not affect local correctness |
| Doctor/inspect/diagnose | `babel-cli/src/doctor.ts`, `babel-cli/src/commands/coreCommands.ts`, `babel-cli/src/inspect/` | Operator-facing inspection | Presentation of existing evidence | Read-only reports; command failures are surfaced |

## Process creation inventory

The repository has many subprocess calls because it supports the CLI, shell
tools, Git, LSP, benchmarks, test fixtures, and optional daemons. BDNS does not
globally patch `child_process`. The first process witness boundary is the two
user-visible execution bridges below; the remaining sites are classified and
remain explicit follow-up boundaries.

### User-visible execution (instrument in B2)

| Boundary | Purpose | Lifecycle / output | Correlation |
| --- | --- | --- | --- |
| `babel-cli/src/sandbox.ts` (`spawnCommandAsync`, `SafeExecutor.shellExecAsync`) | Foreground shell execution from Chat/REPL | Async stdout/stderr caps, timeout, AbortSignal tree termination | Tool call and session event at the caller; BDNS bridge receives an explicit execution id |
| `babel-cli/src/agent/backgroundShell.ts` (`startBackgroundShell`) | User-requested background shell jobs | Async streams, bounded output, await/kill/timeout state | Background task id plus owning session/engine when supplied |
| `babel-cli/src/runners/cliBase.ts` (`spawnCliProcess`) | Explicit CLI runner compatibility path | Async child lifecycle and bounded output parser | Runner call site; not a general process oracle |
| `babel-cli/src/tools/mcpTransport.ts` and `babel-cli/src/tools/auditUiTool.ts` | User-visible external tool transports | Async process transport; caller owns cancellation | Invocation id / tool call id where available |

### Internal helpers and infrastructure (observe only where an explicit bridge exists)

| Boundary family | Representative files | Classification |
| --- | --- | --- |
| Git/status/revision helpers | `src/utils/gitExec.ts`, `src/bridge/workspaceChanges.ts`, `src/agent/capabilityBroker.ts`, `src/evidence/revisionBoundReceipt.ts` | Internal helper; workspace evidence may consume its result, but BDNS must not treat every Git probe as a user process |
| LSP and editor/clipboard adapters | `src/services/lsp/`, `src/interactive/openEditor.ts`, `src/cli/helpers.ts`, `src/ui/clipboard-native.ts` | Internal or operator convenience; instrument only when a caller supplies a correlation id |
| Daemon/session bridge | `src/daemon/client.ts`, `src/bridge/sessionRunner.ts` | Persistent infrastructure; lifecycle is owned by the daemon/session controller |
| Sandboxed/isolated execution | `src/runners/`, `src/services/`, `src/pipeline/`, `src/eval/` | Benchmark, verifier, or test infrastructure; each boundary must remain explicit and is not covered by a global hook |

### Test-only or fixture processes

The `*.test.ts` files under `src/` intentionally spawn Node, Git, or fixture
processes to test isolation, CLI behavior, TUI behavior, and workspace
receipts. They are test-only and are not production witness targets.

### Explicit exclusions

BDNS does not observe arbitrary descendant processes, operating-system process
tables, or unrelated processes in the user's workspace. It does not patch
`spawn`, `exec`, `execFile`, or `fork`. Calls that are internal probes,
benchmark workers, or test fixtures remain exempt unless their owning product
boundary adds a typed bridge.

## Workspace mutation inventory

| Evidence source | What Babel knows | What Babel must not assume |
| --- | --- | --- |
| `WorkspaceTransactionManager` | Declared paths, pre/post images and hashes, revision hashes, changed bytes, rollback status | It covers command-induced or out-of-band changes that were not in the declared batch |
| `SessionEvent` `mutation_batch` | The canonical caller's declared mutation receipt and status | It records declared intent and receipt publication, not every filesystem mutation |
| File writes in `agent/codingLoop`, `agent/toolExecutor`, and services | Specific mutation paths at explicit call sites | A successful write call alone is insufficient evidence of durable on-disk state |
| Git state (`worktreeSafety`, `gitExec`, revision receipts) | Revision and changed-path information where a Git workspace exists | Git status is available, complete, or authoritative for non-Git workspaces |
| Existing daemon file watcher | Debounced add/change signals for configured daemon rules | No watcher event means nothing changed |
| TUI session store / run evidence | BDNS-owned diagnostic artifacts and UI observation | Presentation artifacts define semantic outcomes |

The B3 witness will reconcile declared intent, transaction receipts, bounded
targeted metadata/hashes, watcher signals, and Git candidates. It will never
hash the whole repository on every event and it will exclude BDNS's own
diagnostic directory.

## Existing command and presentation surfaces

BDNS will extend `inspect`, `diagnose`, or `doctor` only after the runtime
contract exists. Existing `inspect tui` remains a presentation inspection
surface. The normal TUI stays free of raw observation traffic; a compact
incident indicator or explicit diagnostic view may be added in B6.

## B0 architecture test plan

The following tests are the acceptance map for later slices:

1. A slow subscriber cannot delay canonical event append beyond the bounded enqueue.
2. A throwing subscriber is isolated and its failure is represented.
3. Queue overflow records dropped/coalesced counts and an incomplete evidence state.
4. Observer sequence numbers are monotonic ingestion order, not universal causality.
5. BigInt, Buffer, Error, and circular/non-JSON values serialize deterministically or become explicit serialization failures.
6. Important process bridges emit requested/started/exit/failure/cancel/timeout facts without monkey-patching Node globals.
7. Secret-shaped arguments, cwd, and environment values are redacted.
8. A watcher failure does not affect canonical execution and never implies no mutation.
9. Declared and observed workspace evidence can corroborate, contradict, or remain unknown.
10. Contradictory canonical/process/workspace evidence creates an incident without overwriting canonical semantics.
11. Diagnostic storage is size-bounded, rotated, redacted, and fail-soft.
12. BDNS-owned files do not recursively self-observe.
13. OTel-disabled and OTel-unavailable runs retain local diagnostics.
14. Shutdown disposes subscribers, watchers, timers, and pending bounded work.
15. `BDNS` disabled preserves current session behavior.

## B0 decision

BDNS is an independent observation layer. Canonical session events, tool
outcomes, workspace transactions, and EvidenceGraph remain authoritative in
their existing domains. BDNS may attach provenance-preserving observations and
diagnoses, but it cannot promote an inference into a canonical fact, mutate
user files, or make execution depend on observer success.
