# Babel Chat pre-experiment audit — evidence and implementation packet

Date: 2026-09-14
Decision: **RUN AFTER SPECIFIC FIXES**

## Revision and coverage

The initial audited runtime revision was `18fd3f50b33525f41bba5e5ce0d233097b5b7413`.
The final live-main check returned `017ec8cc28dbfbabf8138794096b1af00212b474`.
GitHub's comparison returned one added file, `ASTRA_PRETEST_READINESS_FINAL.md`
(227 lines, PR #180), and no runtime-code changes between those revisions.

Source was read through the connected GitHub service. This working environment
could not clone the repository: DNS resolution for github.com failed. It did not
run the Babel package tests, a live TUI, a Windows process test, or any model
inference. `clone.log` records the local checkout failure. This packet is not a
runtime certification and does not claim exhaustive inspection of every optional
provider, MCP server, permission profile, or recovery path.

The readiness report's end-to-end canary is useful evidence for the artifact
admission/verification path. The report explicitly distinguishes its mock
execution and lifecycle records from real provider, tool, and TUI execution. It
cannot by itself certify those runtime boundaries.

## Reproducible local probes

Run with Node.js:

```sh
node extracted_logic_probes.mjs
```

`probe_results.json` records 16 satisfied assertions and no failed assertions on
Node v22.16.0. **These are assertions about suspected defects and positive
controls, not sixteen readiness passes.** P01–P11 use manually transcribed or
adapted source logic / individual expressions and explicit fixtures. P12–P16
are smaller control-flow models, not the actual SSE parser or stream adapter.
All probes are offline, with zero network calls and zero inference calls.
The transcriptions are not certified byte-identical copies of the repository;
the integrated replacements below must test the actual production modules.

## Blocking findings and smallest repairs

### F1 — Durable compaction must include the actual retained working set (P0)

Source: `babel-cli/src/agent/compactionCommit.ts`, `commitCompaction`, approximately
lines 195–400; `babel-cli/src/agent/threadEventLog.ts`,
`rebuildProviderMessagesFromEvents`, approximately lines 250–365;
`babel-cli/src/agent/chatEngine.ts`, native dispatch, approximately lines 1980–2160.

The compaction transaction assembles a live conversation containing the capsule
and strategy-kept messages, then appends a capsule to the durable thread. The
native projector starts after the newest capsule. Kept messages that precede
that event are not delivered by that projector. The preserved-tool IDs can be
computed from the live array rather than the messages actually delivered.

Repair the existing commit/projector pair. Atomically retain or reference the
kept complete tool cycles in the durable projection. Compute preservation
receipts from delivered cycles. Test summary + kept-tail + subsequent events,
not just capsule existence or agreement between two copies of the same projector.

### F2 — Prompt/context preparation and records must describe actual delivery (P0)

Source: `interactive/execution/chat.ts`, engine creation; `chatCore.ts`,
`runChatEngineOnce`, approximately lines 405–640; `chatTransport.ts`;
`agent/chatEngine.ts`, native dispatch; `agent/threadEventLog.ts`.

A supplied TUI engine bypasses the shared runner's factory branch, where the
compiled stack and intent-plan message are passed to a newly created engine.
The shared runner can still write the manifest/intent artifact. This establishes
an injection-path difference; it does not prove that every upstream TUI caller
supplies no equivalent instructions. Capture the actual first request to settle
that question. Live-only working-state messages also require a delivery check
because native requests are projected from the durable thread, not that array.

Use the existing preparation functions before construction, or deliberately
apply updates to an existing engine through its durable input path. Receipts
must describe inputs actually consumed, not independently generated candidates.

### F3 — Stream errors, EOF, partial tool calls and deadlines must be explicit (P0/P1)

Source: `runners/deepInfraApi.ts`, streaming request/retry/parser, approximately
lines 1150–2070; `runners/openRouterApi.ts` inherits this path;
`agent/chatEngine.ts`, native event consumer; `runners/providerMessages.ts`;
`agent/runtimeInvariants.ts`.

Do not synthesize normal completion merely because the body ended. Recognize
provider error events, length/error finishes, malformed/incomplete tool arguments,
and missing terminal markers according to the specific provider contract. Never
execute a partial tool call by substituting `{}`. Continue cancellation and total
request-deadline enforcement through body consumption. Preserve typed errors and
attempt IDs. Reject duplicate declared call IDs as well as duplicate results.
Require `BABEL_RUNTIME_INVARIANTS=enforce` in the experiment preflight, and prove
that invalid payloads generate no outbound request.

### F4 — Preserve terminal cause and evidence through both interfaces (P0)

Source: `interactive/execution/chatCore.ts`, `consumeChatStream` approximately
lines 218–310 and `runChatEngineOnce`; `chatEventDispatch.ts`.

The generic exception path becomes AGENT_FAILURE, and absence of a terminal
becomes CANCELLED. Some fields from a completed event are not forwarded into the
returned result. Finalization is conditional on completion in the shared runner.

Use existing outcomes for known infrastructure failures and keep unknown endings
inconclusive rather than inventing operator cancellation. Forward complete
observability/result fields. Finalize every terminal path without discarding
prior tools, policies, run location, or verifier records. Record cancellation's
source. Test equality of streamed/callback result projections.

### F5 — Long-task policy must expose and enforce the real remaining allowance (P1)

Source: `config/chatEngineLimits.ts`; `agent/chatEngineCriticBudget.ts`,
`computeCriticRepairCostCap` and `computePostWriteRepairWallMs`;
`agent/chatEngine.ts`, `checkBudgets` and `applyPostWriteRepairBudget`.

A long-task flag widens the wall ceiling and disables post-write wall shortening.
It does not disable the finite cost-repair cap. A $10 cap with $1 spent can become
$1.75 total after the first write. The `unlimited` monetary path bypasses this cap;
it is not a safe substitute for an explicit experiment spending limit. Ordinary
post-write wall slices are 90–180 seconds under the current helper defaults.

Expose/freeze all active allowances in the existing contract. Deliberately select
whether repair slices apply to the experiment. Scope cost to the run, not unrelated
prior TUI work. Propagate remaining deadlines through existing abort signals.

### F6 — Delegation must not report child truncation/failure as parent progress (P1)

Source: `agent/lanes/readOnlyAgentLoop.ts`, `runMutationAgentLoop.ts`,
`agent/implementWorktreeAgent.ts`; `agent/chatEngineCriticBudget.ts`.

Children are bounded, separate loops with different context and transport paths.
A four-round cutoff is not task completion. Preserve provider errors even when
partial observations are returned. Distinguish zero changes from successful
mutation: `/\d+\s+changed/` also matches `0 changed`.

The worktree lane does explicitly forward an abort signal into the mutation loop;
do not claim cancellation is absent everywhere. Test remaining-budget and route
propagation separately for each enabled lane. Parent and child process-global
environment mutations require a concurrent two-root test. The first isolated-model
experiment may explicitly omit delegation; do not silently mix that arm with
normal Chat configurations that expose it.

## Required production-module canaries (not executed here)

1. **Cross-mode delivery journey — six executions.** Run one deterministic fixture
   through actual TUI/PTY entry, actual headless CLI entry, and directly configured
   ChatEngine, once uninterrupted and once with a checkpoint/restart. Use 120 tool
   calls, two forced compactions, at least four mutations, failed then successful tests,
   one retry, and a large recoverable tool output. Assert actual serialized inputs,
   schemas, model/endpoint, limits, permission decisions, receipts and terminal.
   Normalize generated IDs/timestamps only; do not normalize away semantic drift.
2. **Provider fault table.** Feed the actual adapter valid completion, truncated
   EOF, mid-stream error, malformed tool JSON, duplicate IDs, an interrupted batch,
   HTTP retry, and usage-only events where that provider supports them. Invalid
   histories must produce zero requests. Incomplete calls must produce zero tools.
3. **Compaction oracle.** Put unique requirements/results only in the retained tail;
   exclude them from the old-prefix summary. Check exact survival after each
   compaction, retry, and restart. Check delivered IDs against preservation receipts.
4. **Limit timeline.** Advance fake clocks to 30m, 1h, 2h, and 4h; include first-write,
   finite cost, observed-only I01, critic, max-turn, and body-stream cases. Assert
   the intended earliest terminating limiter and its evidence, including abort.
5. **Recovery/terminal table.** Inject evidence-write failure, abrupt EOF, operator
   cancellation, provider failure, and crash after mutation but before result
   commit. Require truthful classifications and no automatic mutating replay.
6. **Subagent/process fixture.** Test zero-change, no-finish round exhaustion,
   provider failure with partial observations, parent cancellation, and two roots
   concurrently. On Windows and Linux, spawn a descendant process and prove no
   post-terminal writes. Exercise worktree setup, merge conflicts, and cleanup.

Use existing package test commands plus these newly added cases. The filenames
and cases above are proposed additions, not claims that current named suites
already implement them. Passing these production-boundary assertions, not merely
adding test files, is the acceptance gate.

## First paid activity only after deterministic gates

A tightly capped transport canary on the selected real provider/model: one small
coding fixture in TUI and headless mode, one forced compaction, one edit/test cycle,
and independent final verification. Abort on route/manifest/protocol drift. Do not
interpret this two-run canary as a model-capability estimate. Then preregister and
freeze the actual controlled experimental campaign separately.
