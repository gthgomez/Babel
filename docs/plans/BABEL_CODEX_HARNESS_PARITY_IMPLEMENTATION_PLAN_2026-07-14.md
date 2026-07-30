# Babel ↔ Codex Harness Parity: Adversarial Critique and Implementation Plan

<!--
status: ACTIVE
last_verified: 2026-07-14
scope: Babel CLI, ChatEngine, TUI/REPL, DeepSeek provider integration, terminal execution, evaluation
-->

## Purpose

This document answers four questions:

1. Why do DeepSeek V4 Pro and Flash fail Babel tasks that the models should be capable of completing?
2. Which Babel implementation choices are holding the models back?
3. Which parts of Babel are better foundations than they first appear and should be preserved?
4. What implementation sequence would make the Babel CLI/TUI/REPL at least as usable and reliable as Codex?

The conclusion is adversarial by design: **the primary constraint is the harness, not the model**. Babel often removes useful model capability, corrupts or loses execution state, interrupts productive investigation, and then counts a well-documented failure as a successful harness outcome.

## Evidence boundary

- Babel claims are based on source, tests, plans, and run artifacts in this repository.
- The Codex comparison uses the current observed Codex session and OpenAI's public documentation. Codex's proprietary implementation was not inspected.
- “Codex does X” therefore means either a documented product contract or behavior directly observed in this audit, not a claim about private source code.
- All line references were verified on 2026-07-14.

Official Codex references:

- [Subagents and context isolation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex best practices](https://learn.chatgpt.com/guides/best-practices)
- [Configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic)
- [Sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

## Executive verdict

DeepSeek is not being given a fair chance in Babel's daily-use path.

The highest-impact failure chain is:

1. Babel flattens structured conversation and tool history into Markdown.
2. It sends that entire transcript as a new user message on every tool turn.
3. DeepSeek thinking is disabled whenever native tools are enabled.
4. Several independent policies pressure or terminate the model based on turn counts and writes rather than semantic progress.
5. Foreground commands block the Node event loop, so the TUI cannot render, cancel, or enforce JavaScript timeouts.
6. Multi-turn REPL state is stale or leaks between tasks.
7. Benchmark gates can count an early, richly documented BLOCKED result as a pass.

This creates a perverse system: the harness withholds deliberation, degrades the protocol, interrupts correct localization, and rewards itself for explaining the resulting failure.

The most urgent work is not another prompt, another guard, a larger turn cap, or a more expensive model. It is:

- restore provider-protocol fidelity;
- make the executor asynchronous and cancellable;
- make execution state per-turn and truthful;
- replace overlapping kill switches with one progress-aware arbiter;
- change evaluation so only a correct, verified task outcome counts as success.

## What is holding Babel back

| Rank | Finding | User-visible effect | Severity |
|---|---|---|---|
| 1 | Conversation/tool protocol is flattened | Capable models lose role semantics, tool-call/result pairing, and reliable state | P0 |
| 2 | Thinking is disabled on tool turns | V4 Pro becomes an expensive non-deliberative tool caller | P0 |
| 3 | Benchmark accepts rich failure as success | Policy regressions can ship while task success remains zero | P0 |
| 4 | Foreground process execution is synchronous | TUI freezes; cancellation and JS timeouts do not work | P0 |
| 5 | Persistent ChatEngine freezes first-turn configuration | Model, root, task class, verifier, and policy can be stale after REPL commands | P0 |
| 6 | Multiple policies terminate on proxy metrics | Productive investigation is mistaken for thrash | P0 |
| 7 | Streaming path loses terminal metadata | BLOCKED, budget exhaustion, or cancellation can be rendered/reported incorrectly | P0 |
| 8 | Tool and persistence paths are not singular | Mutations can bypass policy/checkpoints; resumes lose observations | P1 |
| 9 | Chat bypasses the prompt compiler | Babel's strongest control-plane feature is absent from daily use | P1 |
| 10 | TUI capabilities are partially disconnected | Product claims exceed the live path; users get generic or conflicting behavior | P1 |

## Smoking-gun run: the harness stopped a correct investigation

The post-A/B/C A08 smoke is the clearest causal evidence:

- The model correctly localized the target function and all tool calls were on-target: smoke audit:61 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only).
- It had not thrashed, but the zero-write policy stopped it at turn 8 before the first replacement: smoke audit:32 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only), smoke audit:68 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only).
- The result had zero writes and an empty patch: smoke audit:25 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only).
- The campaign labeled that result EARLY_BLOCK_RICH, “not a regression,” and passed Tier D because the failure artifact was complete: smoke audit:54 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only), smoke audit:81 (BABEL_A08_SMOKE_POST_ABC_2026-07-13.md, vault-only).
- The active roadmap explicitly permits PATCH **or** EARLY_BLOCK_RICH to pass: [peer roadmap:299](./BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md#L299), [peer roadmap:317](./BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md#L317).

Honest failure is valuable telemetry. It is not coding-task success.

## Root-cause analysis

### RC-1 — Babel's “native tools” are not a native conversation

[buildChatTurnPrompt](../../babel-cli/src/agent/chatToolDefinitions.ts#L513) serializes every system, user, assistant, and tool message into Markdown headings. It repeats the task under “Current Request” and returns one prompt string.

[DeepSeekApiRunner.executeWithToolsStream](../../babel-cli/src/runners/deepSeekApi.ts#L752) then sends:

    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: prompt }
    ]

The API receives tools natively for the current response, but prior assistant tool calls and tool results are no longer native protocol messages. They are prose inside a user message. ChatEngine also aggregates tool output instead of preserving one tool-result message per call ID: [chatEngine.ts:2063](../../babel-cli/src/agent/chatEngine.ts#L2063).

Consequences:

- the provider cannot reliably pair a result with the tool call that produced it;
- system and assistant content are demoted into user-authored Markdown;
- every turn retransmits an increasingly redundant pseudo-transcript;
- provider-side tool-use training is not exercised as intended;
- compaction and resume have no canonical structured state to preserve.

This is the strongest implementation-level explanation for a capable model appearing less capable inside Babel.

### RC-2 — Deliberation is disabled exactly when coding work needs it

The DeepSeek adapter disables thinking whenever tools are active because the API rejects the current combination of thinking and tool_choice: [deepSeekApi.ts:763](../../babel-cli/src/runners/deepSeekApi.ts#L763).

The observability plan documents the same behavior and leaves a separate no-tools planning turn optional rather than standard: observability plan:318 (BABEL_RUN_OBSERVABILITY_AND_NL_UX_PLAN_2026-07-12.md, vault-only).

This means V4 Pro can be selected for reasoning capability while the live tool path explicitly switches that capability off. Babel then penalizes the same model for spending too many turns localizing or for not mutating quickly enough.

The fix is not to expose or persist chain-of-thought. The fix is to preserve a concise structured plan/hypothesis checkpoint and use a provider-supported deliberation/tool protocol.

### RC-3 — Policy accretion behaves like an adversarial supervisor

The general SWE path can simultaneously apply:

- force-mutate nudges;
- read-thrash restrictions;
- exploration fuses;
- zero-write hard stops;
- stall escalation;
- phase-gated tool restrictions;
- completion-gate strikes;
- critic retries;
- wall, token, cost, and turn budgets.

Relevant implementations:

- [chatTaskClass.ts](../../babel-cli/src/config/chatTaskClass.ts)
- [chatZeroWritePolicy.ts](../../babel-cli/src/agent/chatZeroWritePolicy.ts)
- [readThrashPolicy.ts](../../babel-cli/src/agent/readThrashPolicy.ts)
- [explorationFuse.ts](../../babel-cli/src/agent/explorationFuse.ts)
- [stallDetector.ts](../../babel-cli/src/agent/stallDetector.ts)
- [completionGatePolicy.ts](../../babel-cli/src/agent/completionGatePolicy.ts)

Each policy is locally defensible. Their composition is not. Multiple controllers observe the same incomplete proxies, issue contradictory instructions, and can independently terminate the task. There is no single precedence table and no semantic progress ledger.

Raw “turns without a write” is especially harmful. A turn that identifies the correct symbol, narrows a hypothesis, discovers a reproducer, or rules out a false cause is progress even if it does not mutate a file.

### RC-4 — Daily chat bypasses Babel's best architecture

The default interactive dispatch goes directly to chat execution: [dispatch.ts:95](../../babel-cli/src/interactive/execution/dispatch.ts#L95), [chatCore.ts:510](../../babel-cli/src/interactive/execution/chatCore.ts#L510).

The catalog compiler, selected entries, model adapter, manifest, typed planner/executor/QA stages, and evidence receipts live primarily in deep mode: [pipeline.ts:1468](../../babel-cli/src/pipeline.ts#L1468).

The result is architectural inversion:

- the daily REPL gets the least compiled context and the most heuristic loop control;
- the governed deep path gets the strongest prompt selection and evidence structure;
- improvements described as “implemented in Babel” may never reach the surface users actually run.

Chat should not inherit the entire deep pipeline. It should compile the smallest correct stack—identity, scoped project rules, one relevant domain/skill, and the provider adapter—using the same manifest and precedence rules.

### RC-5 — ChatEngine state is both stale and leaky

The REPL creates ChatEngine once and reuses it: [chat.ts:99](../../babel-cli/src/interactive/execution/chat.ts#L99).

The constructor freezes the initial task, model, project root, task class, limits, verifier, playbook, and policy: [chatEngine.ts:485](../../babel-cli/src/agent/chatEngine.ts#L485). Later turns can re-add the original intent while slash commands mutate only outer REPL state.

Therefore:

- /model can display a new selection while the engine still uses the old runner;
- /project or /retarget can display a new root while tools remain pinned to the old root;
- later tasks inherit prior write counts, gate state, critic state, and exploration budgets;
- prior writes can satisfy a later completion check;
- a long session can become progressively more constrained even when the user starts a new task.

Persistent state should contain conversation and durable event history. Task class, model, root, verifier, policy, budgets, and counters belong to a fresh TurnRuntime.

### RC-6 — There are two large loops and the UI loses truth between them

ChatEngine contains separate non-streaming and streaming loops: [chatEngine.ts:891](../../babel-cli/src/agent/chatEngine.ts#L891), [chatEngine.ts:1665](../../babel-cli/src/agent/chatEngine.ts#L1665).

The interactive streaming consumer does not preserve all gate, routing, policy, observation, budget, and terminal metadata: [chatCore.ts:146](../../babel-cli/src/interactive/execution/chatCore.ts#L146), [chatEventDispatch.ts:105](../../babel-cli/src/interactive/execution/chatEventDispatch.ts#L105).

One concrete symptom is status disagreement:

- blocked and cancelled can be shown to the renderer as a pass: [chat.ts:134](../../babel-cli/src/interactive/execution/chat.ts#L134);
- internal state later treats every non-completed outcome as failed: [chat.ts:161](../../babel-cli/src/interactive/execution/chat.ts#L161).

One state machine must own both streamed presentation and final result. Presentation must never reinterpret terminal truth.

### RC-7 — Foreground commands block the entire TUI

[SafeExecutor.shellExec](../../babel-cli/src/sandbox.ts#L1170) uses spawnSync. Its transient retry uses Atomics.wait: [sandbox.ts:165](../../babel-cli/src/sandbox.ts#L165), [sandbox.ts:1291](../../babel-cli/src/sandbox.ts#L1291).

While it runs:

- the spinner and streamed output stop;
- Ctrl+C and Escape cannot be processed reliably;
- queued input cannot be arbitrated;
- JavaScript timers cannot enforce the tool timeout;
- the renderer appears hung;
- the user cannot distinguish “running” from “dead.”

The code acknowledges that JS timeouts cannot fire during synchronous shell execution: [toolExecutor.ts:183](../../babel-cli/src/agent/toolExecutor.ts#L183).

Babel already has an asynchronous background-shell foundation: [backgroundShell.ts:121](../../babel-cli/src/agent/backgroundShell.ts#L121). The correct fix is one shared asynchronous process supervisor for foreground and background commands, not a second execution implementation.

### RC-8 — Tool ordering, policy, and checkpoint paths are inconsistent

Additional correctness defects compound the main failures:

- Tool batching moves reads before writes, which can reorder write → read/test workflows: [chatEngine.ts:2639](../../babel-cli/src/agent/chatEngine.ts#L2639).
- Direct str_replace mutations can bypass the central policy/checkpoint path: [chatEngine.ts:3008](../../babel-cli/src/agent/chatEngine.ts#L3008), compared with [localTools.ts:1582](../../babel-cli/src/localTools.ts#L1582).
- The circuit breaker returns a terminal result, but ChatEngine can continue until another budget fires: [toolExecutor.ts:545](../../babel-cli/src/agent/toolExecutor.ts#L545), [chatEngine.ts:3212](../../babel-cli/src/agent/chatEngine.ts#L3212).
- Interactive plan approval reruns deep from the original task rather than executing the approved plan envelope: [plan.ts:42](../../babel-cli/src/interactive/execution/plan.ts#L42).
- Pro → Flash fallback mostly covers initialization, not runtime request or rate-limit failures: [chatCore.ts:350](../../babel-cli/src/interactive/execution/chatCore.ts#L350).

### RC-9 — Resume and TUI substrate are event-lossy or disconnected

Resume reconstructs context from user and assistant cells while discarding native tool-call/result history: [conversationSync.ts:13](../../babel-cli/src/services/threadStore/conversationSync.ts#L13).

Failed, blocked, and cancelled turns may persist only the user message because assistant/tool cells are finalized only on completion: [chatCore.ts:426](../../babel-cli/src/interactive/execution/chatCore.ts#L426).

The TUI also has conflicting stdin listeners and partially disconnected systems:

- PromptInput and the conversational renderer both listen to raw stdin: [promptInput.ts:380](../../babel-cli/src/ui/promptInput.ts#L380), [waterfall.ts:2196](../../babel-cli/src/ui/waterfall.ts#L2196).
- Several consumers can install handlers without a single mode arbiter: [keyInput.ts:566](../../babel-cli/src/ui/keyInput.ts#L566).
- Typed tool renderers exist but the live waterfall path remains generic: [toolRenderers.ts](../../babel-cli/src/ui/toolRenderers.ts), [waterfall.ts:1843](../../babel-cli/src/ui/waterfall.ts#L1843).
- OutputBuffer promises a single output choke point, but direct stdout/console writes remain common: [outputBuffer.ts](../../babel-cli/src/ui/outputBuffer.ts).

### RC-10 — Context/model metadata and plan authority are inconsistent

The deployed model registry gives DeepSeek V4 Pro and Flash a context_window of 128,000 but also records context_limit as 1,000,000: [model-policy.json:214](../../config/model-policy.json#L214), [model-policy.json:229](../../config/model-policy.json#L229). The token bar still contains a hard-coded 1M DeepSeek entry even though policy lookup currently takes precedence: [tokenBar.ts:52](../../babel-cli/src/ui/tokenBar.ts#L52).

These contradictions are dangerous even when a current call site happens to choose the correct field. Context budgeting must have one canonical provider capability record and one explicit reserve formula.

Planning authority is similarly fragmented. The plans directory contains active, shipped, stale, historical, and draft documents despite claiming that superseded/completed plans move to archive: [plans README:7](./README.md#L7). The prior canonical roadmap deferred real Codex/Claude parity and reported zero external cells: [ROI roadmap:217](./BABEL_CONSOLIDATED_ROI_ROADMAP_2026-06.md#L217).

## Terminal investigation

Two unrelated terminal problems were observed.

### A. Current Codex-on-Windows command startup

Observed in this audit:

- even trivial exec commands waited several minutes before PowerShell launched;
- direct cmd.exe, PowerShell, pwsh, and git child-process probes completed in milliseconds to low seconds;
- each stalled Codex command had a direct child named codex-windows-sandbox-setup.exe consuming CPU for roughly four to five minutes;
- after that helper completed, the requested shell command ran normally.

Conclusion: the shell and repository are healthy. The bottleneck is the current Codex elevated-sandbox setup path before command launch.

The current user-level configuration selects:

    [windows]
    sandbox = "elevated"

OpenAI documents elevated mode as preferred and unelevated mode as a fallback when the default setup does not work. Unelevated mode has a weaker boundary because it uses a restricted token and ACLs under the current Windows account.

Recommended choices:

1. **Preferred:** run Codex against this repository through WSL2 if that is acceptable operationally.
2. **Targeted fallback:** add a trusted-project override at .codex/config.toml:

       [windows]
       sandbox = "unelevated"

   This requires explicit user approval because it weakens the sandbox boundary for this repository. Restart the Codex app after changing it.
3. **Keep elevated:** investigate the Windows sandbox user's provisioning/ACL state and the repeated setup-helper cost with OpenAI diagnostics. Do not normalize a four-minute setup cost by increasing command timeouts.

No Codex sandbox setting was changed during this audit.

### B. Babel CLI/TUI command execution

Babel's terminal freeze is repository code, not the Codex wrapper issue. spawnSync and Atomics.wait block the Node event loop.

The target terminal contract is:

- all foreground and background commands use one ProcessSupervisor;
- stdout and stderr are bounded byte streams, not a final blocking buffer;
- every process has a stable process/task ID;
- AbortSignal cancellation reaches the process supervisor;
- timeout kills the full process tree and awaits exit;
- Windows, Linux, and Docker adapters preserve the same result contract;
- retry backoff uses asynchronous timers;
- TUI receives started, output, warning, exit, cancelled, and timeout events;
- the final ToolResult is produced from the same event stream.

## How this agent would perform in Babel versus Codex

| Workload | Babel today | Codex in this audit | Why |
|---|---|---|---|
| Small, one-turn, well-localized edit | Potentially competitive | Strong | Babel's ranged reads, exact replacement, and verifier can work before state/policy defects compound |
| Ambiguous multi-file bug | Materially worse | Stronger | Babel removes tool-turn thinking, flattens protocol state, and pressures early mutation |
| Command-heavy debugging | Poor | Degraded by current Windows setup, but recoverable | Babel freezes its own event loop; Codex command tool also stalled, but independent tools allowed the audit to continue |
| Multi-turn retarget/model switch | Unreliable | Stronger | Babel reuses stale constructor state |
| Resume after failure/cancel | Unreliable | Stronger | Babel drops tool history and can restore the wrong execution context |
| Parallel read-heavy audit | Partial | Strong | Codex documents and exposes subagent isolation; Babel has promising subagent code but less reliable live integration |
| Approval-requiring dependency/network step | Often hard-blocked | Recoverable with scoped approval | Babel's workspace_write preset denies several recoverable actions instead of asking |
| Long-context task | Unreliable | Stronger | Babel resends flattened history and has inconsistent context metadata |
| Honest failure reporting | Strong foundation, inconsistent UI | Strong | Babel's internal receipts are good, but transport/UI can mislabel the terminal state |

The current audit itself is instructive. Codex's normal terminal execution failed. I switched to an independent read-only Node filesystem substrate, delegated three bounded audits, preserved a working plan, and continued without losing task state. In Babel, the same model would have faced a blocking foreground executor, stale turn state, missing native tool observations, and several policies capable of terminating the run.

This is effective-intelligence loss: the harness makes the same underlying reasoning system less capable.

## What Babel gets right

These assets should be preserved and unified, not rewritten away:

1. **Surgical tools.** Ranged reads, exact replacement, bounded search, structured patch tools, and read parallelism are good primitives.
2. **Safety foundation.** SafeExecutor has root containment, command allowlisting, injection checks, safe environment construction, output caps, and timeouts.
3. **Honesty infrastructure.** Verified-completion evidence, tamper detection, distinct BLOCKED intent, cost telemetry, and rich run artifacts are stronger than most early harnesses.
4. **Deep compiler.** The prompt catalog, typed pipeline stages, adversarial QA, manifests, and evidence receipts are a genuine differentiator.
5. **Streaming substrate.** AsyncGenerator model streaming, chunk coalescing, Markdown rendering, broken-pipe handling, resize handling, and accessibility work are solid.
6. **Durability foundations.** JSONL/SQLite threads, checkpoints, branches, crash recovery, and background jobs provide the right building blocks.
7. **Test density.** The CLI has substantial unit coverage around individual policies and tools. The missing layer is cross-contract and live-path evaluation.
8. **Failure awareness.** Existing failure-analysis plans already identify read thrash, gate spirals, false verification, wrong localization, and lost patches. The diagnosis needs to become the architecture.

## Target architecture

The replacement architecture should have one source of truth at each layer:

    User / TUI / headless input
              |
              v
       fresh TurnRuntime
       - task and task class
       - effective model/provider
       - project/workspace root
       - permissions and approvals
       - budgets and verifier
              |
              v
       AgentLoop state machine  <---- durable ThreadEventLog
              |
       +------+--------------------------+
       |                                 |
       v                                 v
    ProviderAdapter                ToolRegistry
    structured messages            one policy path
    native call/result IDs          one checkpoint path
       |                                 |
       +---------------+-----------------+
                       v
                ProcessSupervisor
                async / streaming / cancellable
                       |
                       v
                  typed events
                       |
            +----------+-----------+
            v                      v
           TUI              JSON/telemetry/exit

### Required contracts

#### 1. ThreadState

Durable across turns:

- thread_id;
- ordered typed events;
- user/assistant messages;
- native tool calls and results;
- explicit summaries/compaction capsules;
- decisions and approved plan envelopes;
- repository identity history.

It must not contain per-turn gate counters masquerading as durable truth.

#### 2. TurnRuntime

Recomputed at the start of every user turn:

- turn_id;
- current request;
- task class;
- model/provider and routing reason;
- project/workspace root;
- compiled instruction manifest;
- tool capability set;
- permission/approval policy;
- budgets;
- verifier contract;
- progress ledger;
- AbortSignal.

Slash commands invalidate or rebuild the next TurnRuntime, never mutate only presentation state.

#### 3. ProviderConversation

Provider-neutral structured messages:

- system;
- user;
- assistant text;
- assistant tool_call with stable tool_call_id;
- tool_result with the matching tool_call_id;
- compact state capsule.

Provider adapters may transform syntax, but they may not flatten roles into prose.

#### 4. ProgressReceipt

Every loop cycle records semantic deltas:

- new localization evidence;
- narrowed or changed hypothesis;
- reproducer/test discovered;
- target file/symbol change;
- patch attempted or changed;
- verifier result changed;
- external blocker identified with evidence;
- no-progress reason.

Policy may nudge after repeated no-progress receipts. It may not terminally block solely because no file was written.

#### 5. TerminalOutcome

One discriminated union, propagated unchanged through engine, persistence, renderer, JSON, telemetry, and exit code:

- VERIFIED_COMPLETE;
- UNVERIFIED_PATCH;
- BLOCKED_EXTERNAL;
- BLOCKED_POLICY;
- BUDGET_EXHAUSTED;
- CANCELLED;
- INFRA_FAILURE;
- AGENT_FAILURE.

No layer may convert BLOCKED or CANCELLED to “pass” or generic “completed.”

#### 6. VerificationReceipt

Must record:

- command;
- discovery source;
- scope;
- environment/container identity;
- start/end time;
- exit code;
- output digest;
- freshness relative to the last mutation;
- authoritative versus advisory status.

“No discovered verifier” is not equivalent to verification passing.

#### 7. PolicyDecision

One arbiter returns:

- allow;
- nudge;
- restrict with reason and expiry;
- ask approval with scope;
- deny;
- terminal outcome.

At most one policy intervention is presented to the model per cycle. Precedence is explicit and tested.

## Implementation plan

### Phase P0-A — Fix terminal responsiveness and cancellation

**Goal:** no command can freeze the REPL/TUI event loop.

Implementation:

1. Extract SafeExecutor validation and launch preparation into a shared ShellExecutionSpec builder.
2. Create ProcessSupervisor around child_process.spawn.
3. Make foreground shell_exec and test_run await the asynchronous supervisor.
4. Reuse the supervisor for background jobs rather than maintaining a second launcher.
5. Replace Atomics.wait retry backoff with awaitable timers.
6. Pass AbortSignal through ToolContext to the process supervisor.
7. Kill and await the complete process tree on timeout/cancel.
8. Stream bounded output events to the renderer while retaining a bounded final ToolResult.
9. Preserve Docker/profile/allowlist/root-containment behavior exactly.

Primary files:

- babel-cli/src/sandbox.ts
- babel-cli/src/localTools.ts
- babel-cli/src/agent/toolExecutor.ts
- babel-cli/src/agent/backgroundShell.ts
- babel-cli/src/agent/chatEngine.ts
- babel-cli/src/ui/waterfall.ts

Acceptance:

- a 60-second child command does not stop a 50 ms event-loop heartbeat;
- first Ctrl+C produces a cancellation event in under 250 ms;
- the process tree is gone within 2 seconds on Windows and Linux;
- timeout does not leave an abandoned child;
- stdout/stderr cap behavior matches the old executor;
- validation-denial tests are unchanged;
- Docker and native execution return the same typed outcome.

### Phase P0-B — Restore provider protocol fidelity

**Goal:** DeepSeek receives the conversation it was trained to consume.

Implementation:

1. Introduce ProviderMessage and ProviderToolCall types.
2. Change executeWithToolsStream to accept an ordered message array, not one prompt string.
3. Preserve assistant tool calls and one tool result per call ID.
4. Send only the new user turn once.
5. Remove system prompt duplication from pseudo-history.
6. Persist provider-neutral events, not provider request JSON.
7. Add an adapter capability matrix for thinking, tool_choice, parallel calls, max output, and context window.
8. Add recorded conformance fixtures for multi-call, partial streaming arguments, error/retry, and resume.

DeepSeek reasoning strategy:

- If the provider supports thinking with tools when tool_choice is omitted, use that path after a startup capability probe.
- Otherwise, run a concise thinking-enabled deliberation checkpoint before the tool turn for complex/high-uncertainty tasks.
- Persist only a short plan, hypotheses, and next-action rationale—never hidden chain-of-thought.
- Flash may skip the deliberation checkpoint for simple, low-risk turns.

Primary files:

- babel-cli/src/agent/chatToolDefinitions.ts
- babel-cli/src/runners/deepSeekApi.ts
- babel-cli/src/agent/chatEngine.ts
- babel-cli/src/services/threadStore/*

Acceptance:

- request fixtures contain real system/user/assistant/tool roles;
- every tool result has a valid preceding tool_call_id;
- system text never appears inside a user message;
- resume produces the same next provider request as uninterrupted execution;
- Pro reasoning is not silently disabled without a recorded routing reason;
- token use for a ten-turn fixture falls materially versus flattened retransmission.

### Phase P0-C — Separate thread state from turn runtime

**Goal:** model/root/task/policy state is correct on every REPL turn.

Implementation:

1. Reduce the persistent engine to ThreadState plus the shared loop.
2. Build a fresh TurnRuntime for every user submission.
3. Move write counts, gate strikes, verifier state, critic state, exploration counters, and progress into turn scope.
4. Make /model, /project, and /retarget invalidate the next runtime.
5. Record effective model, root, task class, and policy in a turn_started event.
6. Require explicit continuation linkage when a later turn should inherit a prior task's patch/verifier state.

Primary files:

- babel-cli/src/interactive/execution/chat.ts
- babel-cli/src/interactive/commands/config.ts
- babel-cli/src/agent/chatEngine.ts
- babel-cli/src/interactive/chatSessionResume.ts

Acceptance:

- /model changes the next provider request;
- /retarget changes every subsequent tool root;
- a prior task's write cannot satisfy a later task's completion gate;
- task-class changes alter budgets on the next turn;
- UI displays the same model/root recorded in turn_started.

### Phase P0-D — Make terminal truth lossless

**Goal:** one outcome everywhere.

Implementation:

1. Define TerminalOutcome as the only loop terminal type.
2. Carry it unchanged through streaming events, result objects, thread storage, renderer, structured output, telemetry, and process exit.
3. Remove fallback conversions that infer completed from a missing blocked report.
4. Render completed, unverified, blocked, exhausted, cancelled, infra-failed, and agent-failed distinctly.
5. Persist incomplete/failed turns and all preceding tool results before returning.

Primary files:

- babel-cli/src/agent/chatEngine.ts
- babel-cli/src/agent/chatEngineObservability.ts
- babel-cli/src/interactive/execution/chatCore.ts
- babel-cli/src/interactive/execution/chatEventDispatch.ts
- babel-cli/src/interactive/execution/chat.ts
- babel-cli/src/cli/structuredOutput.ts

Acceptance:

- a golden fixture produces the same outcome in TUI text, JSON, telemetry, SQLite/JSONL, and exit code;
- blocked and cancelled are never rendered as pass;
- budget exhaustion cannot become completed;
- failure/cancel resume retains all prior observations.

### Phase P0-E — Stop rewarding failure and shadow the kill switches

**Goal:** evaluation drives task completion rather than artifact completeness.

Immediate changes:

1. A coding cell passes only with a correct patch plus authoritative post-mutation verification.
2. EARLY_BLOCK_RICH remains a useful diagnostic outcome but scores zero for task success.
3. Docker/Linux authoritative evaluation moves before policy tuning, not after it.
4. Disable hard zero-write termination for general_swe.
5. Run read-thrash, force-mutate, exploration-fuse, and stall terminal actions in shadow mode.
6. Keep wall/cost safety ceilings, but classify them as BUDGET_EXHAUSTED rather than BLOCKED.
7. Log which policy would have intervened and whether the task later succeeded.

Primary files:

- babel-cli/src/agent/chatZeroWritePolicy.ts
- babel-cli/src/agent/policyShadow.ts — ablation modes + zero-write shadow + later_succeeded summary
- babel-cli/src/agent/policyShadowPrecisionRecall.ts — offline would-kill precision/recall report
- babel-cli/src/agent/readThrashPolicy.ts
- babel-cli/src/agent/explorationFuse.ts
- babel-cli/src/agent/stallDetector.ts
- babel-cli/src/agent/completionGatePolicy.ts
- babel-cli/src/services/codingTaskSuccess.ts — HF-05 coding gate (no EARLY_BLOCK_RICH pass)
- benchmark/campaign scoring and docs

**Status (2026-07-30):**

| Item | State |
|------|--------|
| Coding-task gate (`classifyCodingTaskGate` / agentBenchmark) | Done (PR #22 lineage) |
| general_swe `zeroWriteHardStopTurns = 0` | Done |
| Stall kill shadow for coding classes | Done (tune + `resolveStallShadowMode`) |
| Soft fuses (force-mutate / read-thrash) without hard restrict | Done for coding classes |
| P0-D TerminalOutcome honesty (budget → BUDGET_EXHAUSTED) | Done (PRs #34–#36); goldens in `terminalOutcomeGolden.test.ts` |
| Live shadow logs (`*_shadow`) + `policy_shadow_summary` later_succeeded | Done (`policyShadow.ts`) |
| Ablation flags `BABEL_POLICY_MODE[_*]=shadow\|enforce\|off` | Done |
| Zero-write shadow one-shot log (no per-turn spam) | Done |
| Zero-write `enforce` is real parity terminal | Done |
| `later_succeeded` = coding gate only; `later_progressed` = mutation | Done |
| Offline precision/recall campaign before re-enforce | Done (report tooling) — `policyShadowPrecisionRecall.ts` + `evidence shadow-precision`; scorecard dimension `shadow_precision_recall`. Live campaign data still required before any coding-class re-enforce. |
| Docker/Linux eval-before-policy ordering | Open — authoritative Docker/Linux evaluation remains an acceptance ordering item: run Docker/Linux eval **before** policy tuning / re-enforce, not after. Not closed by P0-E shadow merge alone. |

Ablation (not a code fork):

- `BABEL_POLICY_MODE` — global default
- `BABEL_POLICY_MODE_ZERO_WRITE` / `_FORCE_MUTATE` / `_READ_THRASH` / `_EXPLORATION_FUSE` / `_STALL_KILL`
- `BABEL_CHAT_ZERO_WRITE_SHADOW_TURNS` — would-have-killed threshold when live hard-stop is 0 (default 12)
- `BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS` — live hard-stop threshold override

Zero-write contract:

- **shadow** (coding default): log `zero_write_shadow` once per session when shadow threshold would kill; soft nudge only if live threshold still &gt; 0
- **enforce**: live threshold → parity `action: terminal` + `zero_write_hard_stop` event
- **off**: silent

Acceptance:

- the A08 fixture is allowed to reach the mutation attempt;
- a rich no-patch result cannot pass a coding benchmark;
- every terminal policy has a measured precision/recall report before enforcement;
- disabling one heuristic is an ablation flag, not a code fork.

### Phase P1-A — Consolidate the agent loop

**Goal:** one reducer/state machine drives submit, streaming, headless, and benchmark surfaces.

Implementation:

1. Define explicit states: orient, investigate, mutate, verify, recover, synthesize, terminal.
2. Define events for provider deltas, tool calls/results, policy decisions, approvals, budgets, and cancellation.
3. Make one reducer update loop state and emit typed effects.
4. Keep presentation as a subscriber; no renderer owns agent semantics.
5. Preserve tool-call order. Parallelize only independent consecutive read-only calls.
6. Honor terminal tool/circuit-breaker results immediately.
7. Route every mutation, including str_replace, through ToolRegistry.

Acceptance:

- streamed and non-streamed fixtures have identical state/outcome;
- write → read/test ordering is preserved;
- no mutation bypasses policy, checkpoint, integrity, and cache invalidation;
- one policy intervention maximum per cycle.

### Phase P1-B — Make progress-aware control replace turn heuristics

**Goal:** intervene only when the agent is actually stuck.

Implementation:

1. Produce a ProgressReceipt after each model/tool cycle.
2. Score repeated no-delta receipts, not raw read/write counts.
3. Prefer recovery actions: summarize evidence, ask user, switch model, run verifier, or narrow scope.
4. Terminally stop only for a hard resource ceiling, explicit policy denial, verified external blocker, or repeated no-progress after recovery.
5. Maintain a human-readable policy precedence table.

Acceptance:

- correct localization counts as progress;
- repeated reads of the same unchanged target do not;
- a failed patch followed by a changed hypothesis resets stall;
- policy ablations show net task-success improvement, not merely earlier failures.

### Phase P1-C — Durable event log and exact resume

**Goal:** resumed execution is observationally equivalent to uninterrupted execution.

Implementation:

1. Persist all events with thread_id, turn_id, item_id, and tool_call_id.
2. Persist cwd/root, model, provider, policy, verifier, approvals, and terminal outcome per turn.
3. Save blocked, failed, and cancelled partial turns.
4. Build provider context from typed events plus explicit compaction capsules.
5. Validate repository identity on resume and ask before switching roots.

Acceptance:

- kill/restart after any event boundary and replay deterministically;
- no tool call is repeated because its result was dropped;
- resumed root/model exactly match the saved turn unless explicitly changed;
- event-log migration is versioned.

### Phase P1-D — Scoped approvals instead of unrecoverable denial

**Goal:** safe, valid work can continue with operator authorization.

Implementation:

1. Convert eligible policy denials into ApprovalRequest events.
2. Support deny, allow once, allow session, and narrow reusable rule.
3. Include exact command, cwd, affected capability, risk, and proposed scope.
4. Headless runs fail truthfully when fresh approval cannot be surfaced.
5. Route all TUI approval input through the single input arbiter.

Acceptance:

- network/install requests do not trigger retry spirals;
- approvals are attributable and auditable;
- subagents cannot exceed the parent permission scope;
- non-interactive behavior is deterministic.

### Phase P1-E — Runtime fallback, compaction, and capability truth

**Goal:** provider limits and failures are handled without losing state.

Implementation:

1. Normalize one ProviderCapabilities record per model.
2. Use context_budget = context_window - max_output - tool/schema reserve - safety margin.
3. Remove conflicting context_limit fields and hard-coded DeepSeek limits.
4. Trigger compaction on actual request tokens, not only message count.
5. Preserve task, progress, patch, verifier, approvals, and recent tool results in the capsule.
6. Add runtime Pro → Flash failover for retryable provider failures, with a visible reason.
7. Do not treat a cheaper same-family retry as independent verification.

Acceptance:

- request size never exceeds the provider budget;
- compaction replay preserves next-action correctness;
- failover preserves structured tool state;
- effective model and fallback reason are visible and persisted.

### Phase P2-A — Bring the smallest compiled Babel stack into chat

**Goal:** daily chat benefits from Babel's differentiator without deep-pipeline latency.

Compile only:

- identity;
- closest project instructions;
- relevant domain/skill;
- safety/permission adapter;
- provider/model adapter;
- task-specific verifier guidance.

Emit the same manifest format as deep mode. Do not duplicate full prompt layers or import planner/QA machinery by default.

Acceptance:

- chat records selected entries and manifest hash;
- instruction precedence is identical across surfaces;
- prompt size is lower than the current flattened path;
- a catalog change reaches chat in an integration test.

### Phase P2-B — Finish or remove disconnected TUI claims

**Goal:** every advertised interaction exists on the live path.

Implementation:

1. One input arbiter with explicit modes: prompt, running, approval, dialog, scrollback.
2. First Ctrl+C cancels the active turn; a second explicit action exits.
3. One OutputBus/OutputBuffer for active rendering.
4. Wire typed tool renderers, permission cards, ScreenManager, scrollback, hydration, and checkpoint restore.
5. Remove footer shortcuts or capabilities that are not implemented.
6. Index session/thread lookup instead of repeated directory/JSONL scans.
7. Display model, root, turn status, process status, and routing/fallback reason.

Acceptance:

- no competing raw-stdin listeners in an active mode;
- zero direct stdout writes during active rendering;
- every footer shortcut has an end-to-end test;
- long-session startup and scrollback meet explicit latency budgets;
- screen-reader mode receives the same semantic events.

### Phase P3 — Simplify, measure, and retire legacy paths

1. Delete the old loop only after fixture parity.
2. Retire JSON/text pseudo-tool protocols where the provider supports native tools.
3. Archive superseded plans and enforce status/link checks in CI.
4. Keep one canonical backlog and one current benchmark report.
5. Split monoliths only along the new contracts; do not move code without changing ownership.
6. Track removal of legacy lines/policies as a deliverable.

## Evaluation plan

### Outcome taxonomy

Report these separately:

- verified task success;
- correct patch but verifier unavailable;
- incorrect patch;
- no patch;
- external block;
- policy block;
- budget exhaustion;
- infrastructure failure;
- cancellation.

Never combine them into a single “pass-like” bucket.

### Comparison design

1. Select at least 20 tasks across TypeScript, Python, repository navigation, tests, multi-file fixes, command-heavy debugging, and long-context work.
2. Run Babel and real Codex on the same repository snapshots.
3. Match wall time, tool permissions, network policy, and maximum cost as closely as possible.
4. Use three repetitions per cell.
5. Evaluate patches and verification blind to harness identity.
6. Record median and variance, not only the best run.
7. Run Babel ablations:
   - structured versus flattened protocol;
   - thinking checkpoint on/off;
   - kill policies enforce/shadow/off;
   - async versus legacy executor;
   - per-turn versus persistent runtime;
   - compiled chat stack on/off.

### Release gates

P0 cannot be declared complete until:

- coding success requires a verified patch;
- provider conformance fixtures pass;
- A08 reaches mutation instead of an eight-turn zero-write kill;
- event-loop heartbeat continues during foreground commands;
- /model and /retarget affect the next turn;
- all terminal outcomes are identical across TUI/JSON/persistence/exit.

Parity candidate cannot be declared until:

- Babel is within 10 percentage points of Codex verified success on the matched suite;
- Babel has no worse than 1.25× Codex median wall time at matched successful outcomes, excluding provider latency;
- cancellation p95 is under 250 ms and process-tree cleanup p95 under 2 seconds;
- resume loses zero tool results in fault-injection tests;
- policy false-positive termination is below 2%;
- three consecutive benchmark runs meet the gate.

“As good as Codex” should mean comparable completed work, not comparable UI surface area or richly described failure.

## Recommended delivery sequence

| Order | Package | Expected leverage | Dependency |
|---|---|---|---|
| 1 | P0-E benchmark truth + policy shadow mode | Stops optimizing the wrong outcome | None |
| 2 | P0-A async process supervisor | Restores terminal usability and cancellation | None |
| 3 | P0-B structured provider protocol | Largest effective-intelligence gain | None |
| 4 | P0-C per-turn runtime | Fixes REPL trust and task leakage | Provider contract helps |
| 5 | P0-D terminal truth | Makes every later experiment measurable | Shared events |
| 6 | P1-A one state machine | Removes divergent loop behavior | P0 contracts |
| 7 | P1-B progress arbiter | Replaces policy accretion safely | Shared loop |
| 8 | P1-C persistence/resume | Makes long work reliable | Typed events |
| 9 | P1-D approvals | Converts recoverable blocks into progress | Typed events/input arbiter |
| 10 | P1-E compaction/fallback | Stabilizes long/provider-stressed runs | Structured history |
| 11 | P2-A compiled chat stack | Restores Babel differentiation | Stable loop |
| 12 | P2-B TUI completion | Makes the capability visible and trustworthy | Process/events/input |
| 13 | P3 deletion/docs cleanup | Reduces ongoing complexity | Parity evidence |

## First two implementation slices

### Slice 1 — Terminal and outcome truth

Deliver:

- asynchronous foreground shell/test execution;
- AbortSignal process cancellation;
- typed process events;
- truthful blocked/cancelled/budget rendering;
- an event-loop/cancellation integration test.

This gives users an immediate improvement and creates trustworthy infrastructure for subsequent work.

### Slice 2 — Structured DeepSeek conversation

Deliver:

- ProviderMessage contract;
- native assistant tool calls and tool results with IDs;
- DeepSeek capability probe and deliberation checkpoint;
- resume/conformance fixtures;
- removal of Markdown pseudo-history from native mode.

This is the most likely slice to produce a step-change in task completion.

## Risks and controls

| Risk | Control |
|---|---|
| Async executor weakens validation | Reuse one prepared execution spec; keep existing denial fixtures as invariants |
| Process cancellation leaves grandchildren | Windows/Linux tree-kill integration tests and post-exit PID checks |
| Structured protocol breaks a provider quirk | Provider-specific adapter fixtures behind one neutral event log |
| Removing kill switches increases spend | Keep wall/cost ceilings; shadow and measure semantic progress |
| Deliberation checkpoint adds latency | Gate by uncertainty/task class; Flash fast path for trivial work |
| One-loop migration causes regression | Replay current golden traces through old/new reducers before cutover |
| Event schema changes strand sessions | Versioned events plus migration and read-only legacy import |
| Chat compiler bloats prompts | Enforce a prompt budget and manifest only the smallest relevant stack |
| Codex comparison becomes marketing | Blind patch evaluation, matched caps, repeated cells, raw result publication |

## Decisions required

1. **Approve the outcome change:** EARLY_BLOCK_RICH is diagnostic, never task success.
2. **Approve policy shadow mode:** zero-write/read-thrash/exploration/stall kills stop enforcing on general SWE until measured.
3. **Choose DeepSeek reasoning strategy:** capability-probed interleaving, or mandatory concise deliberation checkpoint for complex tool turns.
4. **Choose the Windows Codex workaround:** WSL2, keep elevated and diagnose, or explicitly approve repo-local unelevated sandbox mode.
5. **Adopt this document as the canonical harness backlog** and archive conflicting/superseded execution plans after their still-valid items are migrated.

## Definition of done

Babel is ready to call itself Codex-parity when:

- the model receives faithful structured state;
- terminal tools never freeze the interface;
- model/root/task/policy are correct per turn;
- all mutations use one governed path;
- progress—not mere absence of writes—drives intervention;
- task success means a correct, verified result;
- terminal outcomes are truthful on every surface;
- resume is lossless;
- scoped approvals can unblock safe work;
- a repeated, matched, blind suite demonstrates comparable completed-task outcomes.

Until then, spending more on V4 Pro may improve isolated reasoning, but the harness will continue converting model capability into avoidable failure.
