<!--
status: ACTIVE
last_verified: 2026-08-01
-->

# Babel vs Grok Build — Source-First Harness Comparison & Parity Plan

**Research date:** 2026-08-01
**Mode:** Source-code-grounded systems research (not marketing, not Prompt OS)
**Same-model unit of analysis:** Babel harness + model X vs Grok Build harness + model X
**Audience:** Babel maintainers converting findings into architecture decisions, issues, and validation campaigns.
**Related:** [BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md](./BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md), [BABEL_TUI_COMPETITIVE_TEARDOWN_2026-06-26.md](./BABEL_TUI_COMPETITIVE_TEARDOWN_2026-06-26.md), [BABEL_GROK_DUAL_RUN_2026-07-16.md](./BABEL_GROK_DUAL_RUN_2026-07-16.md)

---

## A. Executive decision

| Question                                    | Verdict                                                                                                                                                                                                                                                                                          | Confidence                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Ordinary coding work (edit/run/iterate)** | **Grok Build leads** — denser substrate (durable session actor, native tool feedback, OS sandbox, rewind checkpoints, background/PTY, ACP/headless, stationarity recovery).                                                                                                                      | High on architecture; medium on live same-model pass rates (not run here) |
| **Verified / governed completion honesty**  | **Babel leads** — first-class completion gate (`strict` green authoritative verifier), verifier-integrity tamper checks, zero-write/text-only BLOCKED, diff critic, project test discovery. Grok is primarily model-directed stop + hooks/goal/laziness.                                         | High                                                                      |
| **CLI / TUI product maturity**              | **Grok Build leads** — single Rust composition root, ACP stdio, headless, leader/serve, ratatui-class pager, session fork/rewind, plugin/skill marketplace, long changelog cadence (0.2.x). Babel has a real custom ANSI TUI + rich Commander surface but dual engines and transitional residue. | High                                                                      |
| **Largest Babel bottleneck**                | **Execution substrate under the policy stack** — policies compensate for weaker recovery/persistence/tool continuity; dual ChatEngine vs deep-pipeline loops; incomplete crash recovery of tool/provider state.                                                                                  | High                                                                      |
| **Largest Babel advantage**                 | **Honest completion + verification discipline** (gates, authoritative-test concept, env readiness preflight, evidence/runs layout, multi-provider BYOM).                                                                                                                                         | High                                                                      |
| **Fastest parity path**                     | **Do not rewrite in Rust.** Harden ChatEngine as the single daily runtime: durable event log + tool lifecycle, better edit recovery, background process model, progress-based stopping, ACP/headless completion, then simplify dual paths.                                                       | High                                                                      |
| **Most defensible surpass strategy**        | **Grok-like general runtime substrate + Babel acceptance contracts** (evidence graph, adaptive progress, durable multi-agent, workspace readiness planner).                                                                                                                                      | High                                                                      |

**Strategic answer (section P preview):**
Babel should **adopt a general coding-agent runtime** for ordinary loops, **while preserving and elevating** its verification and evidence layer. This comparison is architectural; it is not a claim about live same-model performance.

---

## B. Repository baselines

### Babel (`gthgomez/Babel`)

| Field                                                                                                                        | Value                                                          | Evidence                                |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Repository role                                                                                                              | Public canonical Babel checkout                                | workspace                               |
| Remote                                                                                                                       | `https://github.com/gthgomez/Babel.git`                        | `git remote`                            |
| Branch                                                                                                                       | `main`                                                         | [SOURCE-VERIFIED]                       |
| Commit                                                                                                                       | `63c394206c2d1d7f8420553e91db3625b09c3d62`                     | [SOURCE-VERIFIED]                       |
| Commit date                                                                                                                  | 2026-08-01 01:29:21 -0500                                      | [SOURCE-VERIFIED]                       |
| Message                                                                                                                      | Merge PR #42 `fix/c2-workspace-dep-preflight`                  | [SOURCE-VERIFIED]                       |
| CLI version                                                                                                                  | `babel-cli` **0.1.0**                                          | `babel-cli/package.json`                |
| Language / runtime                                                                                                           | TypeScript / Node.js (ESM)                                     | [SOURCE-VERIFIED]                       |
| Structure                                                                                                                    | Product monorepo: control-plane prompts + `babel-cli/` runtime | [SOURCE-VERIFIED]                       |
| License                                                                                                                      | MIT                                                            | `LICENSE`, package.json                 |
| Bins                                                                                                                         | `babel`, deprecated stubs `babel-lite`/`bl`                    | package.json                            |
| Main entry                                                                                                                   | `babel-cli/src/index.ts` → Commander                           | [SOURCE-VERIFIED]                       |
| Interactive entry                                                                                                            | `interactive/BabelRepl.ts` via bare `babel`                    | [SOURCE-VERIFIED]                       |
| Headless                                                                                                                     | `chat-headless` mode, protocol JSON-RPC sketch, stream-json    | [SOURCE-VERIFIED]                       |
| OS                                                                                                                           | Windows-first engineering + Linux CI; portable scripts         | [DOCUMENTED]/[SOURCE-VERIFIED] patterns |
| Tests                                                                                                                        | ~386 `*.test.ts` under `babel-cli/src`                         | [SOURCE-VERIFIED] count                 |
| Public completeness                                                                                                          | Full OSS product source (canonical)                            | [DOCUMENTED] CLAUDE.md                  |
| Generated code                                                                                                               | Limited; hand-authored TS dominant                             | [INFERRED]                              |
| **Canonical live path for ordinary coding:** **ChatEngine** (`chat` / `chat-headless`), not deep pipeline. [SOURCE-VERIFIED] |
| **Governed path:** `plan` / `deep` → `runBabelPipeline`. [SOURCE-VERIFIED]                                                   |
| **Deprecated:** babel-lite surface is dead at the binary entry point; legacy internal lite code remains. [SOURCE-VERIFIED]   |

### Grok Build (`xai-org/grok-build`)

| Field                                        | Value                                                                          | Evidence                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Research source                              | Grok Build comparison checkout                                                 | local corpus reference; path intentionally omitted      |
| Remote                                       | `https://github.com/xai-org/grok-build.git`                                    | [SOURCE-VERIFIED]                                       |
| Branch                                       | `main`                                                                         | [SOURCE-VERIFIED]                                       |
| Local commit                                 | `69f0ba880aa98f55e3ac1dcc570e2f332f825fe2`                                     | [SOURCE-VERIFIED]                                       |
| Commit date                                  | 2026-07-23 17:12:33 +0000                                                      | [SOURCE-VERIFIED]                                       |
| Message                                      | Synced from monorepo                                                           | [SOURCE-VERIFIED]                                       |
| Local `SOURCE_REV`                           | `95d84f443eddcbed6cbfd6eed22e2eafe6b3939d`                                     | file [SOURCE-VERIFIED]                                  |
| Remote tip `SOURCE_REV` (fetched 2026-08-01) | `8d69c91f02bcacf01e98d5aebbf2f92547c45738`                                     | [SOURCE-VERIFIED] web; **local tree lags monorepo tip** |
| Product version                              | crate **0.2.111** (`xai-grok-pager-bin`, `xai-grok-shell`, `xai-grok-version`) | [SOURCE-VERIFIED]                                       |
| Language                                     | Rust (edition 2024 workspace)                                                  | [SOURCE-VERIFIED]                                       |
| Binary                                       | `xai-grok-pager` (shipped as `grok`)                                           | README [DOCUMENTED] + Cargo.toml                        |
| Structure                                    | Generated workspace root; crates under `crates/codegen`, `common`, `prod/mc`   | [SOURCE-VERIFIED]                                       |
| License                                      | Apache-2.0 first-party                                                         | LICENSE                                                 |
| Contributions                                | External contributions **not accepted**                                        | CONTRIBUTING.md [DOCUMENTED]                            |
| Sync model                                   | Periodic monorepo export; public may lag proprietary product                   | README [DOCUMENTED]                                     |
| Ported tools                                 | Codex (Apache-2.0) + OpenCode (MIT) under `xai-grok-tools`                     | THIRD_PARTY_NOTICES [SOURCE-VERIFIED]                   |
| OS                                           | macOS/Linux supported; Windows best-effort                                     | README [DOCUMENTED]                                     |
| Build                                        | `cargo run -p xai-grok-pager-bin`; needs DotSlash + protoc                     | README                                                  |
| Tests                                        | ~154 `*test*.rs` + large in-crate modules; shell/tests ~32 integration files   | [SOURCE-VERIFIED] counts                                |
| Entry modes                                  | TUI default; headless; stdio ACP; serve; leader                                | `pager-bin/main.rs` [SOURCE-VERIFIED]                   |

**Public-source limitations (Grok):**

- Monorepo export may omit private backends, managed config secrets, full sampling backends.
- Auth/model access is product-gated (xAI).
- Local research tree is **~9 days older** than remote SOURCE_REV tip—re-sync before implementation waves that depend on newest behavior.
- Do **not** copy ported Codex/OpenCode code without license compliance.

---

## C. Architecture maps

### C.1 Grok Build system map

```text
xai-grok-pager-bin (composition root)
  ├─ TUI: xai-grok-pager (+ minimal render mode)
  ├─ Headless / stdio ACP / serve / leader: xai-grok-shell::agent::app
  └─ SessionActor ──run_session select!──►
         ├─ handle_prompt outer loop (goal + stop hooks)
         │     └─ process_conversation_turn inner loop
         │           sample (xai-grok-sampler) → tools → continue
         ├─ ChatStateActor (conversation authority)
         ├─ PermissionManager + hooks (xai-grok-hooks)
         ├─ WorkspaceOps → ToolBridge → tool implementations
         ├─ Terminal/PTY + BackgroundTaskRegistry
         ├─ Checkpoint / HunkTracker / optional worktree
         ├─ Compaction (xai-grok-compaction)
         ├─ MCP / skills / plugins / workflows (Rhai)
         └─ JSONL session storage (+ atomic writes)
```

**Dependency direction:** pager-bin → shell → agent/tools/workspace/sampler; tools port implementations; workspace owns FS/permission/checkpoint.

### C.2 Babel system map

```text
babel (Commander index.ts)
  ├─ bare / interactive → BabelRepl (custom ANSI TUI, not Ink)
  ├─ default task / chat / chat-headless → ChatEngine ★ daily path
  ├─ plan / deep → runBabelPipeline (orchestrator → plan → QA → executor)
  ├─ protocol/ JSON-RPC (sketch) | daemon/ IPC optional
  └─ ChatEngine
        for turn in maxTurns:
          LLM (native tools | text tools | JSON ChatTurn)
          → toolExecutor → localTools → SafeExecutor
          → stall / zero-write / read-thrash / gate / critic policies
        → transcript / threadStore / OTel / patchRecovery log
```

**Dual authority [SOURCE-VERIFIED]:** ChatEngine for ordinary work; deep pipeline for governed multi-stage. Policies heavily decorate ChatEngine.

### C.3 Shared request lifecycle (fix failing test)

**User:** find failing test cause → smallest fix → run authoritative tests → repair → report evidence.

#### Grok path (ordinary coding)

1. CLI/TUI prompt → SessionActor `handle_prompt`
2. Session created/resumed; project instructions/skills loaded
3. Context: agent system prompt + AGENTS.md + conversation items
4. Sampler turn; tools stream via ACP updates
5. Tool prepare: parse args → plan gate → PreToolUse hooks → PermissionManager
6. Optional FS rewind begin at prompt boundary
7. Parallel tools (same-file serial lock)
8. Edits via search_replace / write / apply_patch (codex)
9. Shell/PTY for tests; background task if long
10. Tool results → ConversationItem; model continues
11. Model stop → Stop hooks / todo / laziness / optional goal verifier
12. TurnCompleted + JSONL persistence; rewind finalize
13. Resume via session load / updates replay

**Authority:** continuing execution with soft progressive recovery (nudge identical tools @8, stop @16; stop hooks max 8).

#### Babel path (ChatEngine daily)

1. TUI or `babel "<task>"` → chat dispatch → ChatEngine
2. System stack compile + repo map + preflight + **workspace dep note** if unready
3. Turn loop maxTurns; ChatTurn tool_calls (≤6) or completion
4. Policy: phase nudges, read thrash, zero-write, stall, repetition
5. Mutations: str_replace / write_file / apply_patch(+git apply) + checkpoint + patchRecovery append
6. Shell via SafeExecutor allowlist; background shell partial
7. Completion attempt → **completionGatePolicy** (writes + authoritative verifier)
8. Gate reject → strikes (max 3) or BLOCKED; text-only loop interventions
9. Optional diff critic; verifier integrity
10. Transcript + threadStore; resume loads messages (tool state partial)

**Authority:** honesty/safety stop often overrides continue.

### C.4 Failure lifecycle summary

| Failure               | Grok                                            | Babel                                 | Better             | Babel change                           |
| --------------------- | ----------------------------------------------- | ------------------------------------- | ------------------ | -------------------------------------- |
| Provider rate limit   | Sampler retry (max ~15; 429 path)               | Runner-specific retry/fallback        | Grok more unified  | Normalize provider retry + Retry-After |
| Provider timeout      | Retry classification                            | Turn timeout 120s + fallbacks         | Mixed              | Explicit fail frames + resume          |
| Malformed tool call   | Parse recovery + tool error to model            | Zod/text parse fail → observation     | Grok slightly      | Stronger recovery messages             |
| Tool process crash    | Terminal error + task state                     | ToolResult error / circuit breaker    | Grok bg tasks      | Task registry + cleanup                |
| User cancel           | Cancel paths + outstanding usage drain          | AbortController                       | Both OK            | Ensure tool kill on cancel             |
| Agent process kill    | JSONL + optional durable rewind; incomplete WAL | patchRecovery log; transcript partial | Grok               | Durable tool lifecycle event log       |
| Context overflow      | Auto-compact + preflight overflow               | CompactionManager ~100k               | Grok deeper        | Compact survival tests + rehydrate     |
| Patch conflict        | search_replace errors; codex fuzzy apply_patch  | str_replace exact; git apply          | Grok edit recovery | Normalized match + better errors       |
| Test failure          | Model-directed; no hard gate                    | Gate may reject complete              | Babel honesty      | Keep; add adaptive repair budget       |
| Missing dep           | Model shell install (permission)                | workspaceDepPreflight note/block      | Babel advantage    | Generalize readiness planner           |
| Missing executable    | Tool error                                      | SafeExecutor / discovery              | Similar            | Doctor integration                     |
| Permission denial     | ACP prompt / auto classifier                    | Approval queue / profiles             | Grok UX            | Streamlined ask UX                     |
| Identical action      | Nudge 8 / hard 16                               | repetitionDetector                    | Both               | Align progress-based thresholds        |
| Stalled investigation | Laziness detector / goal continue               | read thrash / force-mutate / BLOCKED  | Grok softer        | Progress-based (not static strike-out) |
| Partial mutation      | Rewind checkpoint                               | Checkpoint + recovery log             | Grok rewind UX     | Auto restore + undo parity             |
| TUI disconnect        | Leader/ACP reconnect patterns                   | Weaker                                | Grok               | Headless/ACP first                     |
| Resume after restart  | Session load + plan resume + subagent rehydrate | Message restore; counters fragile     | Grok               | Full state restore schema              |

---

## D. File-and-symbol map

### Grok (commit `69f0ba88…`, SOURCE_REV `95d84f44…`)

| Subsystem    | Path                                                   | Key symbols                                                |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| Entry        | `xai-grok-pager-bin/src/main.rs`                       | `main`, `run_headless`, `run_stdio_agent`                  |
| Session loop | `xai-grok-shell/.../run_loop.rs`                       | `run_session`                                              |
| Turn loop    | `.../turn.rs`                                          | `handle_prompt`, agentic `loop`, `IdenticalToolCallRun`    |
| Tools        | `.../tool_calls.rs`, `tool_dispatch.rs`                | `prepare_tool_call`, `dispatch_tool`, `lock_path_for_args` |
| Stop         | `.../stop_gate.rs`                                     | `run_stop_gate`, `MAX_STOP_HOOK_CONTINUATIONS_PER_TURN=8`  |
| Goal         | `.../goal.rs`, `goal_stop_detector.rs`                 | `run_goal_round_end`, stop regex panel                     |
| Compaction   | `session/compaction.rs`, `xai-grok-compaction`         | `run_compact`, full-replace                                |
| Checkpoints  | `xai-grok-workspace/session/checkpoint.rs`             | `RewindCheckpoint`, `TurnBoundary`                         |
| Permissions  | `workspace/permission/manager.rs`                      | YOLO / Auto / Ask                                          |
| Sandbox      | `xai-grok-sandbox`                                     | process-level nono/Landlock                                |
| Subagents    | `tools/.../task/coordinator.rs`, `subagent-resolution` | spawn/resume/worktree                                      |
| Edit         | `tools/.../search_replace`, `codex/apply_patch`        | exact + fuzzy patch                                        |
| Persistence  | `session/storage/mod.rs`, `persistence.rs`             | JSONL, atomic write                                        |
| Ports        | `xai-grok-tools/THIRD_PARTY_NOTICES.md`                | Codex/OpenCode                                             |

### Babel (commit `63c39420…`)

| Subsystem      | Path                                                                                                 | Key symbols                              |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Entry          | `babel-cli/src/index.ts`                                                                             | `runCli`                                 |
| TUI            | `interactive/BabelRepl.ts`, `ui/screenManager.ts`                                                    | custom component trait                   |
| Dispatch       | `interactive/execution/dispatch.ts`, `chatCore.ts`                                                   | chat vs plan vs deep                     |
| Agent loop     | `agent/chatEngine.ts`                                                                                | `ChatEngine`, `submitMessageStream`      |
| Tools schema   | `agent/chatToolDefinitions.ts`                                                                       | `ChatToolActionSchema`, `ChatTurnSchema` |
| Executor       | `agent/toolExecutor.ts`, `localTools.ts`, `sandbox.ts`                                               | `SafeExecutor`                           |
| Completion     | `agent/completionGatePolicy.ts`                                                                      | `evaluateExecuteCompletionHonesty`       |
| Policies       | `chatZeroWritePolicy`, `readThrashPolicy`, `stallDetector`, `repetitionDetector`, `budgetKillPolicy` | thrash controls                          |
| Compaction     | `agent/chatCompaction.ts`                                                                            | `CompactionManager`                      |
| Patch recovery | `agent/patchRecovery.ts`                                                                             | `appendPatchRecovery`                    |
| Checkpoints    | `services/checkpoints.ts`                                                                            | `CheckpointRecord`                       |
| Deps           | `services/workspaceDepPreflight.ts`                                                                  | `detectWorkspaceDepPlan`                 |
| Deep path      | `pipeline.ts`, `pipeline/executorLoop.ts`                                                            | governed stages                          |
| Protocol       | `protocol/*`                                                                                         | JSON-RPC thread/turn                     |
| Providers      | `runners/*`                                                                                          | multi-provider                           |

---

## E. Full harness comparison (condensed, evidence-backed)

### E.1 Agent-loop architecture

| Axis              | Grok                                                                     | Babel                                          |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Structure         | Nested while-true: session `select!` → prompt outer → sample/tools inner | Imperative `for turn < maxTurns` in ChatEngine |
| Durable authority | ChatStateActor + JSONL                                                   | In-memory engine + transcript/thread store     |
| Native FC         | Yes (sampler multi-protocol)                                             | Yes + text-tool + JSON turn fallbacks          |
| Finish            | Model end_turn + stop hooks / goal                                       | Model completion + **hard honesty gate**       |
| Max steps         | max_turns + stationarity 16                                              | maxTurns + gate strikes 3 + thrash BLOCKED     |
| Optimizes for     | Continue execution, recover, UX control                                  | Prevent false complete + thrash kill           |

**Babel policy complexity as compensation [INFERRED]:** zero-write, read-thrash, text-only BLOCKED, force-mutate, gate strikes exist partly because the model can spin without substrate-level progress recovery (Grok nudges/continues more often).

### E.2 Provider abstraction

- **Grok:** unified sampler + sampling-types; retry centralized (`retry.rs` max 15). [SOURCE-VERIFIED]
- **Babel:** many runners (`deepSeekApi`, `openAiApi`, `ollama`, CLI runners…); semantics can diverge by provider. [SOURCE-VERIFIED]
  **Implication:** same model via different providers can change harness behavior more on Babel → normalize message/tool/finish frames.

### E.3 Context engineering

- **Grok:** agent templates (encrypted prompt templates exist), AGENTS.md, skills, plugins, compaction multi-mode, artifact-aware compact, goal state persistence.
- **Babel:** chat stack compile + repo map + preflight + task-class budgets + CompactionManager; deep path separate stack.
  **Same-model edge:** Grok rehydrates long sessions better; Babel injects stronger task/verify framing for execute class.

### E.4 Tool runtime

Both have read/range/list/grep/glob/write/replace/shell/web/todo/subagent/MCP/LSP-ish surfaces.

**Material feedback differences [SOURCE-VERIFIED]:**

- Grok `search_replace`: exact + replace_all + normalized match helpers + structured edit details.
- Babel `str_replace` / `apply_patch` via git; patchRecovery is log-only.
- Grok: PTY, monitor, kill_task, task_output, scheduler, workflow, image tools.
- Babel: background shell partial; SafeExecutor allowlist; richer verifier-oriented tools (`test_run`, discovery).
- Grok tool concurrency with **per-file mutex**; Babel parallel reads serial writes, concurrency 6.

### E.5 Editing and patch transactions

|                  | Grok                            | Babel                             |
| ---------------- | ------------------------------- | --------------------------------- |
| Primary edit     | search_replace                  | str_replace                       |
| Patch engine     | Codex apply_patch (fuzzy seek)  | git apply + size limits           |
| Rewind           | FS RewindCheckpoint per prompt  | CheckpointRecord + CLI undo       |
| Crash durability | JSONL + optional durable rewind | append-only recovery log          |
| Concurrent edits | File lock serialization         | Worktree agent / serial mutations |

**Near-correct edit recovery:** Grok better [INFERRED from normalized match + rewind + apply_patch port].

### E.6 Environment readiness

**Babel advantage [SOURCE-VERIFIED]:** `workspaceDepPreflight` detect/probe/install/block — wired chat + SWE campaigns.
**Grok:** envrc/workspace discovery/toolchain via shell model; no equivalent first-class import-ready gate found in researched surface.
**Surpass lever:** generalize readiness planner (Python/Node/Rust/Java, services, browsers, Docker).

### E.7 Verification and completion

|                     | Grok                                 | Babel                                                 |
| ------------------- | ------------------------------------ | ----------------------------------------------------- |
| Primary stop        | Model-directed                       | Model + **completionGatePolicy**                      |
| Authoritative tests | Optional goal verifier / model       | Required/strict receipts; reject ad-hoc `_verify*.py` |
| Tamper              | Hooks                                | `verifierIntegrity`                                   |
| False complete      | Laziness + stop hooks + stationarity | Gate rejects + strikes → BLOCKED                      |

**Tradeoff [SOURCE-VERIFIED + INFERRED]:** Babel reduces false completes; gate strikes + hard BLOCKED can kill recoverable sessions. Grok may false-complete more, recover more often.

### E.8 Progress / stall / stopping (Babel policy classification)

| Policy                                            | Class                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Completion honesty (green authoritative verifier) | **Necessary safety / product truth** — preserve                               |
| Verifier integrity                                | **Necessary safety** — preserve                                               |
| Budget kill (cost/token explosion)                | **Necessary safety** — keep                                                   |
| Diff critic                                       | **Useful** — keep advisory with repair budget                                 |
| Zero-write / force-mutate                         | **Useful but should be progress-adaptive**; partly compensates weak substrate |
| Read thrash                                       | **Useful advisory → restrict tools**; avoid early terminal kill               |
| Text-only 3 nudge / 5 BLOCKED                     | **Too static**; risk kill recoverable sessions                                |
| Gate strikes max 3 → BLOCKED                      | **Likely kills recoverable**; prefer last-chance repair window                |
| Repetition detector                               | **Necessary** (doom-loop); align with Grok 8/16 progressive                   |
| Phase tool policy                                 | **Useful process**; keep soft                                                 |
| Plan-then-execute hard mode                       | **Product policy** — preserve for governed                                    |

**Progress-based alternative:** track (1) new files touched, (2) unique failing tests shrinking, (3) verifier exit deltas, (4) edit success rate, (5) novel tool targets. Soft nudge → tool restriction → last-chance → BLOCKED only on flat progress + budget.

### E.9 Persistence and recovery

Grok: chat_history.jsonl, updates.jsonl, goal state, plan mode, atomic renames, subagent rehydrate, bg task manifest.
Babel: transcript restore, threadStore cells+SQLite meta, checkpoints, patchRecovery (no auto-replay), daemon recovery for queue only.

**Work for Babel to survive kill mid tool cycle:** durable event log (user msg → model stream chunks → tool call start/end → results → gate decisions) with schema version + resume that rebuilds providerConversation and counters.

### E.10 Subagents

Grok: first-class coordinator, optional worktree isolation (`xai-fast-worktree`), usage fold, resume, types.
Babel: chat `sub_agent`, implement worktree agent, agent teams service, short max rounds (4/8).

**Combined design:** Grok isolation+coordinator + Babel write_scope + parent acceptance gate on merge evidence.

### E.11 Extensibility

Grok: plugins marketplace, hooks, skills, MCP, Rhai workflows, ACP.
Babel: MCP client+server (control-plane-ish), plugins, runtime hooks, skills packaging, protocol sketch.

**Parity:** production ACP + skill/plugin load path for coding sessions (not only catalog MCP).

### E.12 Permissions / sandbox

Grok: process OS sandbox + sophisticated bash risk classifier + YOLO/Auto/Ask.
Babel: path root + command allowlist + dry-run default + approval profiles + optional Docker for benchmarks.

**Parity:** OS-level sandbox optional profile (Windows Job Object / Linux Landlock where possible) without abandoning allowlist.

### E.13 Observability

Both: telemetry stacks. Babel: OTel, cost ledger, policy event log, blocked attempt ledger, evidence bundles. Grok: unified log, mixpanel, session metrics, turn spans.
Babel stronger on **run evidence artifacts**; Grok stronger on **live session product telemetry**.

---

## F. CLI comparison

| Capability     | Grok                             | Babel                                     |
| -------------- | -------------------------------- | ----------------------------------------- |
| Primary binary | `grok` / `xai-grok-pager`        | `babel`                                   |
| Interactive    | default TUI                      | bare `babel` → BabelRepl                  |
| Headless       | first-class `run_headless`       | chat-headless + flags                     |
| ACP            | stdio agent first-class          | protocol JSON-RPC (earlier maturity)      |
| Multi-client   | leader/serve                     | bridge/daemon partial                     |
| Doctor         | present                          | `babel doctor`                            |
| Auth           | product OIDC/device              | multi-provider keys                       |
| Plan mode      | enter/exit plan tools + approval | `babel plan` + hard plan                  |
| Resume/undo    | session load, rewind             | `babel resume`, `babel undo`, checkpoints |
| Automation     | headless + ACP                   | stream-json, benchmarks, daemon           |

---

## G. TUI/REPL comparison & Babel design recommendation

| Axis        | Grok                        | Babel                                  |
| ----------- | --------------------------- | -------------------------------------- |
| Stack       | ratatui-family custom pager | Custom ANSI (explicitly not React/Ink) |
| Scrollback  | first-class tool blocks     | historyCells + waterfall               |
| Diff review | hunk tracker integration    | checkpoint/diff tooling                |
| Session nav | fork, rewind, load          | resume/list/inspect                    |
| Input       | advanced prompt + queue     | PromptInput V2, vim, paste             |

**Recommendation:** keep custom TUI (no Ink rewrite). Prioritize: (1) durable transcript cells matching event log, (2) tool-call lifecycle UI, (3) rewind/undo UX tied to checkpoints, (4) headless parity for CI, (5) optional ACP attach so editors share the same Session/ChatEngine core.

---

## H. Capability matrix

Legend: **HAS** / **PARTIAL** / **ABSENT** / **UNVERIFIED** — code in researched trees.

| Capability                 | Babel   | Grok              | Notes                                      |
| -------------------------- | ------- | ----------------- | ------------------------------------------ |
| Interactive coding TUI     | HAS     | HAS               | Different stacks                           |
| Autonomous file edit/shell | HAS     | HAS               |                                            |
| Native tool calling        | HAS     | HAS               | Babel also text/JSON fallbacks             |
| OS sandbox                 | PARTIAL | HAS               | Babel allowlist+docker                     |
| ACP                        | PARTIAL | HAS               |                                            |
| Session resume             | PARTIAL | HAS               | Babel counters/tool state gaps             |
| Session fork/rewind        | PARTIAL | HAS               | Babel checkpoints ≠ full rewind            |
| Plan vs build modes        | HAS     | HAS               |                                            |
| MCP client                 | HAS     | HAS               |                                            |
| Skills/plugins/hooks       | PARTIAL | HAS               | Grok marketplace+Rhai                      |
| Headless JSON              | PARTIAL | HAS               |                                            |
| Multi-model BYOM           | HAS     | PARTIAL           | Babel multi-provider; Grok product-centric |
| Background long processes  | PARTIAL | HAS               | PTY/monitor/kill                           |
| Compaction                 | HAS     | HAS               | Grok multi-mode deeper                     |
| Completion acceptance gate | HAS     | PARTIAL           | Babel stronger                             |
| Workspace dep preflight    | HAS     | ABSENT/UNVERIFIED | Babel C2 advantage                         |
| Subagent worktrees         | PARTIAL | HAS               |                                            |
| Doom-loop control          | HAS     | HAS               | Progressive vs hard BLOCKED                |
| Verifier integrity         | HAS     | UNVERIFIED        | Babel explicit                             |
| Desktop/web surfaces       | ABSENT  | UNVERIFIED        | Out of primary scope                       |

---

## I. Failure-mode matrix

(See C.4 for expanded table.) Core pattern: **Grok continues with recovery scaffolding; Babel stops with honesty scaffolding.** Optimal system does both: recover while truthfully refusing false complete.

---

## J. Copy / adapt / reject / preserve

| Item                                         | Action                                                   | Licensing / risk                                                                       |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Nested SessionActor + event log durability   | **Adapt** (TS ChatEngine)                                | Own implementation; do not copy Rust verbatim                                          |
| Per-file edit locks + parallel tools         | **Copy design**                                          | Clean-room                                                                             |
| Stationarity nudge 8 / stop 16               | **Adapt**                                                | Clean-room                                                                             |
| Stop hooks KeepWorking                       | **Adapt** as optional hooks                              | Clean-room                                                                             |
| FS rewind checkpoints                        | **Adapt** from Babel checkpoints → prompt-indexed rewind | Clean-room                                                                             |
| Codex apply_patch / OpenCode tools           | **Do not paste** without Apache/MIT compliance & notices | THIRD_PARTY_NOTICES applies to Grok ports; Babel should reimplement or vendor properly |
| OS sandbox nono                              | **Adapt idea**; evaluate dependencies separately         | Apache sandbox code not free to copy without compliance                                |
| Completion honesty gate                      | **Preserve & extend**                                    | Babel IP                                                                               |
| Verifier integrity                           | **Preserve**                                             | Babel                                                                                  |
| Workspace dep preflight                      | **Preserve & generalize**                                | Babel advantage                                                                        |
| Dual ChatEngine + deep pipeline              | **Converge** (not full delete deep yet)                  | Migration plan                                                                         |
| Static gate strike-out / text-only 5 BLOCKED | **Redesign** → progress-based                            | —                                                                                      |
| Prompt OS catalog                            | **Preserve** as optional depth, not daily loop core      | Out of primary scope                                                                   |
| Grok encrypted system prompts                | **Reject** as dependency                                 | Product-specific                                                                       |

---

## K. Parity roadmap (dependency-ordered)

### P0 — Substrate for same-model completion (2–4 weeks)

1. **Durable session event log** (message/tool lifecycle, gate decisions) + resume rebuilds `providerConversation`
2. **Normalize provider message/tool/finish** frames across runners
3. **Edit recovery upgrade:** better mismatch diagnostics; optional whitespace-normalized match; atomic writes
4. **Background process registry** (start/await/kill/output tails) like Grok tasks
5. **Progress-based thrash controller** replacing pure strike BLOCKED (keep honesty gate)
6. **Checkpoint ↔ undo UX** aligned with mutation stream

### P1 — Product surfaces parity (3–6 weeks)

7. **ACP or hardened protocol** for headless/editor attach
8. **Compaction survival:** rehydrate critical tool outputs; tests for overflow mid-task
9. **Subagent coordinator** + optional git worktree isolation with evidence return contract
10. **Permission UX** streamlining (auto/ask) without dropping SafeExecutor
11. **Optional OS sandbox profile**

### P2 — Surpass layer (parallelizable after P0 honesty retained)

12. **Acceptance contract engine:** task → success predicates → evidence graph
13. **Generalized workspace readiness planner** (langs, services, browsers)
14. **Adaptive verification:** authoritative discovery + targeted retest + receipt invalidation after edits
15. **Multi-agent durable orchestration** with merge/conflict policy

### P3 — Cleanup

16. Collapse dual loops: deep becomes profile of ChatEngine (or thin stage wrappers)
17. Remove legacy lite paths / dead modes
18. TUI session navigation polish

---

## L. Fastest-path backlog (first 10–20 items, exact order)

1. Spec `SessionEventV1` schema (user, assistant_delta, tool_call, tool_result, gate, compact, error)
2. Write-through event log in ChatEngine before each mutation and after each tool
3. Resume: rebuild providerConversation + toolCallLog + gateStrikes + lastVerifierReceipt
4. Integration test: kill mid-tool → resume continues without re-applying same write
5. Provider `normalizeFinishReason` + retry-after helper shared by runners
6. `str_replace` error payload: show nearest match / line context (no silent fail)
7. BackgroundShell registry API parity (list/await/kill) exposed as tools
8. Replace `MAX_GATE_STRIKES` hard BLOCKED with progress score + last-chance repair window (keep strict green for final allow)
9. Text-only: cap at restrict tools + force tool_choice, not immediate BLOCKED at 5
10. Checkpoint auto-create at prompt boundary (not only pre-mutation)
11. Wire `babel undo` to last prompt boundary
12. Compaction: pin last failing test output + current diff summary always
13. Headless stream-json: emit gate reject events (not only final)
14. Subagent: return structured `EvidenceBundle` summary to parent
15. ACP MVP or promote protocol from sketch with e2e test
16. Doctor check: workspace dep readiness
17. Document same-model eval harness config (next section)
18. Remove or quarantine dead babel-lite entry points from help
19. Per-file write mutex for parallel tool batches
20. Flaky-test classifier separate from verifier_red gate

---

## M. Surpass architecture

```text
                    ┌─────────────────────────────┐
                    │   Acceptance Contract        │
                    │  predicates + evidence graph │
                    └──────────────┬──────────────┘
                                   │
 User → SessionActor(TS) → Model X │
              │                    │
              ├─ Tools (durable)   │
              ├─ Progress monitor ─┤── adaptive: nudge / restrict / continue
              ├─ Readiness planner │
              ├─ Verifier service ─┤── invalidate receipts on file set change
              └─ Multi-agent coord │── worktree + merge evidence
                                   ▼
                         Honest terminal states:
                         COMPLETE_VERIFIED | BLOCKED | NEEDS_USER | BUDGET
```

**Principles:**

- Substrate maximizes recoverable progress (Grok-like).
- Acceptance layer prevents false complete (Babel-like, stronger).
- Progress metrics replace static doom counters.
- Evidence is first-class, not prompt-only.

---

## N. Benchmark plan (same-model)

### N.1 Unit of analysis

Product config packs:

- `babel-chat-strict` (default ChatEngine + strict gate)
- `babel-chat-required` (weaker gate)
- `babel-deep` (pipeline)
- `grok-default` (if runnable)
- After changes: `babel-chat-parity-p0`

Hold **model slug + temperature + tool set** fixed where possible.

### N.2 Task suites

1. **Env-red:** missing venv/import (measures readiness vs thrash)
2. **Single-file fix:** failing unit test
3. **Multi-file refactor** with patch conflicts
4. **Long context:** large repo navigation + late edit
5. **False-complete temptation:** model asked to “done” without tests
6. **Crash/resume:** SIGKILL mid-edit
7. **Identical action loop** inducement
8. **Permission denial** recovery
9. **Verifier tamper** temptation
10. **Background test** long-running

### N.3 Metrics

Pass rate, verified pass rate, false-complete rate, empty-patch rate, env false-block rate, premature-stop rate, recovery success, duplicate mutation rate, patch fail rate, tools before first useful mutation, red-test repair rate, cost/tokens/wall per pass, compaction survival, human interventions, resume correctness.

### N.4 Trajectory labels

Model | context | tool feedback | editing | environment | provider | harness policy | verification | persistence | TUI | benchmark infra.

### N.5 Existing Babel assets

Use `babel-cli` agent benchmarks / SWE-bench pro campaign scripts as seed; add harness-ablation flags rather than only model ablations.

**Runtime verification status of this research:** architectural claims [SOURCE-VERIFIED]; live same-model pass rates [UNKNOWN] until campaign run.

---

## O. Final recommendation table

| Priority | Change                                 | Parity / surpass | Same-model impact            | Effort | Dependency   | Acceptance gate                        |
| -------- | -------------------------------------- | ---------------- | ---------------------------- | ------ | ------------ | -------------------------------------- |
| P0       | Durable event log + resume             | Parity           | High recovery                | M      | —            | Kill/resume e2e green                  |
| P0       | Provider frame normalize + retry       | Parity           | Medium                       | M      | —            | Cross-runner fixture suite             |
| P0       | Edit error quality / match help        | Parity           | High first-pass edit         | S      | —            | Near-miss str_replace tests            |
| P0       | Background task registry               | Parity           | Medium long jobs             | M      | event log    | await/kill tests                       |
| P0       | Progress-based stopping                | Parity+          | High (fewer premature stops) | M      | metrics      | Ablation: fewer BLOCKED on recoverable |
| P0       | Keep completion honesty                | Surpass preserve | High trust                   | S      | —            | No false complete on fixture           |
| P1       | ACP/protocol productionize             | Parity           | Medium automation            | L      | event log    | ACP e2e                                |
| P1       | Compaction rehydrate critical tails    | Parity           | High long tasks              | M      | compact      | Overflow mid-fix fixture               |
| P1       | Subagent worktree+evidence             | Parity           | Medium                       | L      | —            | Isolated child e2e                     |
| P1       | Optional OS sandbox profile            | Parity           | Safety                       | L      | —            | Escape tests                           |
| P2       | Acceptance contracts + evidence graph  | Surpass          | High verified pass           | L      | gate         | Contract suite                         |
| P2       | Generalized readiness planner          | Surpass          | High env-red                 | M      | preflight C2 | Multi-lang fixtures                    |
| P2       | Receipt invalidation after edits       | Surpass          | Medium honesty               | S      | gate         | Edit after green → re-verify           |
| P3       | Converge deep into ChatEngine profiles | Debt             | Maintainability              | L      | P0–P1        | Feature parity tests                   |
| P3       | Remove legacy lite paths               | Debt             | Clarity                      | S      | —            | Help/CLI smoke                         |

---

## P. Strategic conclusion

**Should Babel become a Grok Build-like general coding-agent runtime with stronger verification, or preserve a materially different architecture?**

**Recommendation: become a Grok-like general runtime substrate, with Babel’s verification/honesty as the permanent differentiator—not a parallel governed universe.**

### Why (source evidence)

1. **Grok’s advantage is substrate, not “more policy.”** Nested SessionActor, durable JSONL, prepare→permission→dispatch tools, rewind checkpoints, stationarity recovery, background/PTY, ACP/headless, and subagent isolation are the mechanisms that keep the same model moving through failures. [SOURCE-VERIFIED]
2. **Babel’s advantage is truth of completion.** `completionGatePolicy`, authoritative verifier notion, verifier integrity, zero-write honesty, and workspace dep preflight address failure modes Grok largely leaves to the model + soft detectors. [SOURCE-VERIFIED]
3. **Babel’s dual engine + thrash policy stack** is partly compensating for weaker durable execution and recovery—not a free architectural choice. ChatEngine is already the daily product path; deep should become a profile, not a second product. [SOURCE-VERIFIED]
4. **Rewriting Babel in Rust / cloning Grok** is blocked by contribution policy, monorepo export lag, licensing of ported tools, and loss of Babel’s verification IP. Clean-room adaptation in TypeScript is correct.
5. **Surpass is not “more strikes.”** It is acceptance contracts + evidence graph + adaptive progress + readiness planner on top of a recoverable loop.

### What not to do

- Do not center roadmap on Prompt OS catalog expansion for coding-task parity.
- Do not drop completion honesty to chase raw pass rate.
- Do not hard-BLOCK recoverable sessions with static counters.
- Do not vendor Codex/OpenCode ports without license discipline.

### Immediate next move

Implement **P0 backlog items 1–5** (event log, resume, provider normalize, edit errors, progress stopping) behind flags; run a **same-model ablation** on env-red + single-file fix + false-complete suites; re-sync Grok tree to remote SOURCE_REV tip before any “Grok still does X” implementation debates.

---

## Research limitations

| Limitation                                          | Impact                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Local Grok tree older than remote SOURCE_REV tip    | Some behaviors may have changed; re-sync before code-level port decisions      |
| No live same-model runtime campaign in this session | Pass-rate claims architectural, not numerical                                  |
| Grok public export incomplete vs private monorepo   | Unknown proprietary features possible                                          |
| Windows best-effort for Grok builds                 | Runtime-verify Grok on Windows may be limited                                  |
| Prompt middle truncation in original request        | Full section list recovered from offloaded prompt + research standards applied |
| Proprietary Grok auth/models                        | Headless product comparison partially blocked                                  |

---

## Evidence quality summary

- Architecture maps, entry points, loops, gates, ports, versions: **[SOURCE-VERIFIED]**
- Large test suites presence: **[SOURCE-VERIFIED]** counts; not full suite execution here
- Same-model superiority claims: **[INFERRED]** from mechanisms pending benchmark
- README product claims treated as **[DOCUMENTED]** unless code-confirmed

---

## Implementation waves (for maintainers → issues)

**Wave A — Durable ChatEngine**
Issues: event log schema; write-through; resume rebuild; kill/resume e2e.

**Wave B — Tool substrate**
Issues: bg tasks; file locks; str_replace diagnostics; provider retry.

**Wave C — Adaptive progress**
Issues: progress score; rework gate strikes; text-only policy.

**Wave D — Surfaces**
Issues: protocol/ACP; compaction survival; subagent evidence.

**Wave E — Surpass**
Issues: acceptance contracts; readiness planner v2; deep path convergence.

---

_End of plan. This document is intended to convert directly into architecture decisions, GitHub issues, and a controlled validation campaign._
