<!--
status: ACTIVE
last_verified: 2026-08-01
-->

# Babel vs OpenAI Codex OSS — Runtime Architecture Research

**Research execution date:** 2026-08-01
**Mode:** Source-code-grounded systems research (not marketing, not Prompt OS)
**Same-model unit of analysis:** Babel harness + model X vs Codex OSS harness + model X
**Audience:** Babel maintainers converting findings into ADRs, migration waves, GitHub issues, fault-injection campaigns, and controlled same-model benchmarks
**Related:** [BABEL_VS_GROK_BUILD_HARNESS_2026-08-01.md](./BABEL_VS_GROK_BUILD_HARNESS_2026-08-01.md), [BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md](./BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md), [ADR-010-app-server-protocol.md](../adr/ADR-010-app-server-protocol.md)

**Evidence labels:** `[SOURCE-VERIFIED]` `[TEST-VERIFIED]` `[DOCUMENTED]` `[HISTORY-VERIFIED]` `[INFERRED]` `[UNKNOWN]` `[CONFLICT]` `[PROPRIETARY-BOUNDARY]` `[RUNTIME-VERIFIED]` (runtime/fault-injection not executed in this pass unless noted)

**Research limits (honest):**

- Full same-model benchmark (Track A/B) **not run** here — plan in §Z.
- OS sandbox fault injection **not run** — plan in §Z.
- Codex local checkout was stale (2026-06-26); analysis used `origin/main` tip and/or tree content matching tip SHA `feee0b0…`.
- Server-side Responses / ChatGPT environment registry behavior is `[PROPRIETARY-BOUNDARY]`.

---

## A. Executive decision

| Question                                                      | Verdict                                                                                                                                                                                                                                                   | Confidence                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Ordinary coding work** (understand repo → mutate → iterate) | **Codex OSS leads** — unified `run_turn` substrate, freeform `apply_patch` with fuzzy seek, unified exec/PTY, multi-OS sandbox, mature multi-agent, app-server + exec-server                                                                              | High on architecture; medium on live same-model pass rates (not run)                                |
| **Verified / governed completion honesty**                    | **Babel leads** — completion gates, authoritative verifier concept, ad-hoc `_verify*.py` rejection, zero-write policy, diff critic, verifier integrity, `ENV_BLOCKED` honesty                                                                             | High                                                                                                |
| **Long-running recovery** (crash, compact, resume, fork)      | **Codex OSS leads** — rollout JSONL + thread-store + state DB, fork/resume/rollback protocol, remote + local compact, subagent graph                                                                                                                      | High on Codex; Babel has real thread event log + SQLite meta but thinner crash/tool-lifecycle story |
| **CLI product maturity**                                      | **Codex leads** — multitool surface (exec, resume, fork, doctor, sandbox, mcp, app-server, plugin, cloud…)                                                                                                                                                | High                                                                                                |
| **TUI/REPL maturity**                                         | **Codex leads** — ratatui + embedded app-server; Babel has real custom ANSI REPL + rich slash surface but dual-engine residue                                                                                                                             | High                                                                                                |
| **App-server / external clients**                             | **Codex leads by a wide margin** — production JSON-RPC protocol + transports + daemon; Babel is Phase D1 sketch (`protocol/`)                                                                                                                             | High                                                                                                |
| **Provider portability**                                      | **Babel leads** — multi-provider runners, native tools stream + text-tool fallback; Codex is OpenAI Responses–centric with limited alternate providers                                                                                                    | High                                                                                                |
| **Environment readiness honesty**                             | **Babel leads / competitive** — workspace dep preflight + `ENV_BLOCKED` distinct from policy block; Codex has install-context + doctor + env selection but less “failed because toolchain missing” as a first-class terminal class                        | Medium–High                                                                                         |
| **Largest Babel bottleneck**                                  | **Execution substrate under the policy stack** — dual ChatEngine vs deep pipeline, path-allowlist sandbox (not OS sandbox by default), sketch app-server, weaker PTY/background/unified-exec, apply_patch via `git apply` not first-class freeform engine | High                                                                                                |
| **Largest Codex bottleneck (OSS)**                            | **Completion honesty + provider lock-in** — turn completes when model stops (+ stop hooks); no universal green-test gate; deep Responses/encrypted-reasoning/remote-env affordances are `[PROPRIETARY-BOUNDARY]`                                          | High                                                                                                |
| **Largest Babel advantage**                                   | Verification / terminal honesty + multi-provider + Windows-first portability engineering                                                                                                                                                                  | High                                                                                                |
| **Largest Codex advantage**                                   | Unified agent runtime substrate (sandbox, protocol, tools, rollout, multi-agent, remote envs)                                                                                                                                                             | High                                                                                                |
| **Fastest parity path**                                       | **Do not rewrite Babel in Rust.** Keep TypeScript ChatEngine as single daily runtime; **adapt** Codex patterns (tool lifecycle, durable rollout, protocol expansion, edit reliability, optional OS sandbox sidecar) while **preserving** Babel gates      | High                                                                                                |
| **Most defensible surpass strategy**                          | **Codex-like general runtime substrate + Babel acceptance contracts** (evidence graph, authoritative verify, ENV_BLOCKED, progress-based stop)                                                                                                            | High                                                                                                |
| **Recommended migration architecture**                        | **Hybrid TypeScript core + optional native sidecars** (sandbox/exec helpers), not full Rust rewrite                                                                                                                                                       | High                                                                                                |

**Strategic answer (preview of §AC):**
Babel should **adopt a general coding-agent runtime** for ordinary loops (single durable harness, stronger tools/persistence/protocol/sandbox), **while preserving and elevating** its verification/honesty layer. This comparison is architectural and is not a claim about live same-model performance.

---

## B. Repository baselines

### B.1 Babel (`gthgomez/Babel`)

| Field               | Value                                                            | Evidence                             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Repository role     | Public canonical Babel checkout                                  | workspace                            |
| Remote              | `https://github.com/gthgomez/Babel.git`                          | `[SOURCE-VERIFIED]` `git remote`     |
| Default branch      | `main`                                                           | `[SOURCE-VERIFIED]`                  |
| Commit SHA          | `63c394206c2d1d7f8420553e91db3625b09c3d62`                       | `[SOURCE-VERIFIED]`                  |
| Commit date         | 2026-08-01 01:29:21 -0500                                        | `[SOURCE-VERIFIED]`                  |
| Subject             | Merge PR #42 `fix/c2-workspace-dep-preflight`                    | `[SOURCE-VERIFIED]`                  |
| Tag                 | `v0.1.0` (+ dirty describe `v0.1.0-63-g63c3942`)                 | `[SOURCE-VERIFIED]`                  |
| CLI package         | `babel-cli` **0.1.0**                                            | `babel-cli/package.json`             |
| Languages           | TypeScript (ESM), PowerShell tools                               | `[SOURCE-VERIFIED]`                  |
| Structure           | Control-plane prompts + `babel-cli/` runtime monorepo            | `[SOURCE-VERIFIED]`                  |
| License             | MIT                                                              | `LICENSE`                            |
| Bins                | `babel`, deprecated stubs `babel-lite` / `bl`                    | package.json                         |
| Main entry          | `babel-cli/src/index.ts` → Commander                             | `[SOURCE-VERIFIED]`                  |
| Interactive         | `interactive/BabelRepl.ts` via bare `babel`                      | `[SOURCE-VERIFIED]`                  |
| Headless            | `chat-headless`, protocol sketch, stream-json                    | `[SOURCE-VERIFIED]`                  |
| Daemon              | `daemon/` IPC + queue + recovery                                 | `[SOURCE-VERIFIED]`                  |
| MCP server          | `mcp/server.ts`                                                  | `[SOURCE-VERIFIED]`                  |
| OS                  | Windows-first engineering + Linux CI                             | `[DOCUMENTED]` + portable scripts    |
| Tests               | **386** `*.test.ts` under `babel-cli/src`; **73** under `agent/` | `[SOURCE-VERIFIED]` count 2026-08-01 |
| Public completeness | Canonical OSS product source                                     | `[DOCUMENTED]` CLAUDE.md             |
| Generated code      | Limited (`tools/_generated/…`); hand-authored TS dominant        | `[SOURCE-VERIFIED]`                  |

**Canonical live path for ordinary coding:** **ChatEngine** (`chat` / interactive / `chat-headless`).
**Governed path:** `plan` / `deep` → `runBabelPipeline`.
**Deprecated:** babel-lite CLI surface; internal lite code remains.

### B.2 OpenAI Codex OSS (`openai/codex`)

| Field                      | Value                                                                          | Evidence                                           |
| -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Research source            | Codex OSS comparison checkout                                                  | local corpus reference; path intentionally omitted |
| Remote                     | `https://github.com/openai/codex.git`                                          | `[SOURCE-VERIFIED]`                                |
| Default branch             | `main`                                                                         | `[SOURCE-VERIFIED]`                                |
| **Research tip SHA**       | `feee0b07c7564455e253312e62e6dba69dc861d3`                                     | `[SOURCE-VERIFIED]` `origin/main`                  |
| Tip date                   | 2026-08-01 14:42:11 +0000                                                      | `[SOURCE-VERIFIED]`                                |
| Tip subject                | Increase remote plugin bundle size limits (#36485)                             | `[SOURCE-VERIFIED]`                                |
| Local checkout SHA (stale) | `c4644684…` (2026-06-26) — **do not use as baseline**                          | `[SOURCE-VERIFIED]`                                |
| Sync metadata              | Commits include `GitOrigin-RevId: …` (monorepo export)                         | `[HISTORY-VERIFIED]` tip commit body               |
| Latest stable release tag  | `rust-v0.146.0` (2026-07-29)                                                   | `[SOURCE-VERIFIED]` GitHub releases API            |
| Pre-release                | `rust-v0.147.0-alpha.4` (2026-07-31)                                           | `[SOURCE-VERIFIED]`                                |
| Workspace crate version    | `0.0.0` (workspace package)                                                    | `[SOURCE-VERIFIED]` `codex-rs/Cargo.toml`          |
| npm shim                   | `@openai/codex` `0.0.0-dev`                                                    | `[SOURCE-VERIFIED]` `codex-cli/package.json`       |
| Languages                  | **Rust** (edition 2024 workspace) + thin Node launcher + TS SDK                | `[SOURCE-VERIFIED]`                                |
| License                    | Apache-2.0 (+ NOTICE, Ratatui MIT derivation)                                  | `[SOURCE-VERIFIED]`                                |
| Structure                  | `codex-rs/*` crates, `codex-cli` npm, `sdk/`, bazel, docs                      | `[SOURCE-VERIFIED]`                                |
| Main binary                | `codex` (`codex-rs/cli`, default → TUI)                                        | `[SOURCE-VERIFIED]`                                |
| Headless                   | `codex exec` (`codex-rs/exec`)                                                 | `[SOURCE-VERIFIED]`                                |
| App-server                 | `codex app-server`                                                             | `[SOURCE-VERIFIED]`                                |
| Exec-server                | `codex exec-server`                                                            | `[SOURCE-VERIFIED]`                                |
| MCP server                 | `codex mcp-server`                                                             | `[SOURCE-VERIFIED]`                                |
| OS                         | macOS seatbelt, Linux landlock/bwrap, Windows restricted-token sandbox         | `[SOURCE-VERIFIED]` sandbox crates                 |
| Generated code             | prost/protobuf, Cargo.lock `@generated`, schema fixtures                       | `[SOURCE-VERIFIED]`                                |
| Contribution note          | Large first-party OpenAI development; public OSS incomplete for cloud backends | `[DOCUMENTED]` chatgpt/README patterns             |

**Build/test environment for this research:** Windows host, PowerShell, `gh` + `git` against remotes; no full `cargo test` of Codex or live agent dual-run executed in this pass.

---

## C. Public-source boundary

| Layer                           | Babel                                             | Codex OSS                                                                                                   |
| ------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Public local implementation** | Full harness, tools, TUI, daemon, pipeline, tests | Full Rust core, TUI, app-server, exec-server, sandboxes, tools                                              |
| **Public protocol**             | JSON-RPC sketch ADR-010 / `protocol/`             | Production app-server-protocol + exec-server-protocol + TS exports                                          |
| **Model behavior**              | Whatever BYOM provider returns                    | Responses API model behavior                                                                                |
| **OpenAI server behavior**      | N/A (multi-provider)                              | Responses stream, `/responses/compact`, sticky routing, encrypted reasoning round-trip, remote env registry | `[PROPRIETARY-BOUNDARY]` |
| **Proprietary product surface** | None required                                     | ChatGPT cloud tasks, marketplace share backend, analytics/Sentry ingest, remote control mobile              | `[PROPRIETARY-BOUNDARY]` |
| **Inaccessible**                | Closed model internals of any provider            | Same + any unreleased monorepo crates not exported                                                          |

**Rule used throughout:** never attribute server-side Responses advantages to “Codex harness” without separating them.

---

## D. Architecture maps

### D.1 Babel component map

```text
User
 ├─ Interactive REPL (BabelRepl) ──► executeChatTask ──► ChatEngine
 ├─ chat / chat-headless ─────────────────────────────► ChatEngine
 ├─ plan / deep ──────────────────────────────────────► runBabelPipeline (v9)
 ├─ daemon (IPC jobs) ────────────────────────────────► queue / recovery
 └─ protocol sketch ──────────────────────────────────► JSON-RPC host (D1)

ChatEngine
 ├─ compileChatStack (AGENTS.md / Claude.md / skills)
 ├─ runners/* (DeepInfra / DeepSeek / Ollama / …)
 ├─ tool defs → policy → approval → toolExecutor → sandbox SafeExecutor
 ├─ completionGate / zeroWrite / diffCritic / ENV_BLOCKED
 ├─ threadEventLog + threadStore (cells.jsonl + meta.sqlite)
 └─ checkpoints / patchRecovery
```

### D.2 Codex component map

```text
Client (TUI | app-server | exec | mcp-server)
  │ Submission { Op }
  ▼
ThreadManager → CodexThread → Session
  │ RegularTask / Compact / Review
  ▼
run_turn (session/turn.rs)
  ├─ context_manager + AGENTS.md + skills/plugins/hooks
  ├─ ModelClientSession → Responses API (/responses, /compact)
  ├─ ToolRouter → CoreToolRuntime handlers
  │    ├─ unified_exec / shell / apply_patch / multi_agents / MCP …
  │    └─ sandboxing (seatbelt | landlock+bwrap | Windows RT)
  └─ RolloutRecorder + ThreadStore + state DB
       + EventMsg stream to client
```

### D.3 Trust boundaries

| Boundary        | Babel                                                            | Codex                                                                            |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Model I/O       | Provider HTTP APIs                                               | Responses HTTP/WS + optional sticky headers                                      |
| Tool exec       | Node process; path jail + allowlist; Docker optional (benchmark) | OS sandbox + execpolicy + network-proxy + approvals                              |
| Persistence     | Local runs/ threads under project/home                           | `~/.codex/sessions` rollouts + SQLite state                                      |
| External client | Weak (sketch protocol)                                           | App-server JSON-RPC multi-transport                                              |
| Remote env      | Limited                                                          | Exec-server + remote Noise relay → ChatGPT env registry `[PROPRIETARY-BOUNDARY]` |

### D.4 Lifecycle (shared conceptual model)

```text
Thread create/resume → Turn start → Sample model → (Tool* → Sample)* → Turn complete
                 ↘ compact / fork / cancel / crash ↗ recovery via durable log
```

Babel maps “Turn” to user submission + inner `maxTurns` tool loop.
Codex maps `Op::UserInput` → `run_turn` sampling loop with tool follow-ups.

---

## E. Canonical runtime-path determination

### E.1 Babel — actually used paths

| Path                       | When                                     | Primary symbols                  | Status                               |
| -------------------------- | ---------------------------------------- | -------------------------------- | ------------------------------------ |
| **ChatEngine (canonical)** | Interactive, `babel chat`, headless chat | `ChatEngine.submitMessageStream` | **Live primary** `[SOURCE-VERIFIED]` |
| Deep pipeline              | Explicit `plan`/`deep`                   | `runBabelPipeline`               | Live secondary                       |
| Lite/session lanes         | Internal/historical                      | `agent/session.ts`, lanes        | Residual; CLI deprecated             |
| Protocol host              | Experimental                             | `protocol/*`                     | Sketch only                          |
| Daemon jobs                | Background                               | `daemon/queue.ts`                | Live but not primary coding UX       |

**Do not optimize for lite as product path.** Consolidate daily coding on ChatEngine.

### E.2 Codex — actually used paths

| Path                  | When                 | Primary symbols                         | Status                                    |
| --------------------- | -------------------- | --------------------------------------- | ----------------------------------------- |
| **TUI → core**        | Default `codex`      | MultitoolCli → tui → Session/`run_turn` | Live primary                              |
| **app-server → core** | IDE/desktop          | MessageProcessor → ThreadManager        | Live primary for clients                  |
| **exec → core**       | Headless CI          | `codex exec`                            | Live                                      |
| MCP server            | Agent-as-MCP         | `mcp-server`                            | Live                                      |
| Exec-server           | Process/FS isolation | process/* RPCs                          | Live (local); remote registry proprietary |

---

## F. File-and-symbol map

### F.1 Babel (highest signal)

| Subsystem      | Path                                  | Symbols                                         |
| -------------- | ------------------------------------- | ----------------------------------------------- |
| Entry          | `babel-cli/src/index.ts`              | `runCli`                                        |
| Mode taxonomy  | `cli/constants.ts`                    | `VALID_MODES`                                   |
| REPL           | `interactive/BabelRepl.ts`            | `startInteractiveSession`                       |
| Chat task      | `interactive/execution/chat.ts`       | `executeChatTask`                               |
| Engine         | `agent/chatEngine.ts`                 | `ChatEngine`, `submitMessageStream`             |
| Loop reducer   | `agent/agentLoopReducer.ts`           | `reduceAgentLoop`                               |
| Turn isolation | `agent/turnRuntime.ts`                | `beginUserSubmission`                           |
| Tool schema    | `agent/chatToolDefinitions.ts`        | `buildChatToolDefinitions`, `ChatTurnSchema`    |
| Tool exec      | `agent/toolExecutor.ts`               | `createToolExecutor`, `executeActionWithPolicy` |
| Mutations      | `agent/governedMutations.ts`          | `governedStrReplace`                            |
| Events         | `agent/threadEventLog.ts`             | `ThreadEvent`, kinds                            |
| Compaction     | `agent/chatCompaction.ts`             | `CompactionManager`                             |
| Completion     | `agent/completionGatePolicy.ts`       | gate helpers                                    |
| ENV honesty    | `agent/implementorPolicy.ts`          | `detectEnvBlockedFromText`                      |
| Sandbox        | `sandbox.ts`                          | SafeExecutor                                    |
| Thread store   | `services/threadStore/threadStore.ts` | cells + meta.sqlite                             |
| Protocol       | `protocol/types.ts`                   | `BabelProtocolMethod`                           |
| Pipeline       | `pipeline.ts`                         | `runBabelPipeline`                              |
| Dep preflight  | `services/workspaceDepPreflight.ts`   | preflight                                       |

### F.2 Codex (highest signal)

| Subsystem     | Path                                                   | Symbols                                       |
| ------------- | ------------------------------------------------------ | --------------------------------------------- |
| Loop          | `codex-rs/core/src/session/turn.rs`                    | `run_turn`, `run_sampling_request`            |
| Task entry    | `core/src/tasks/regular.rs`                            | `RegularTask`                                 |
| Thread        | `core/src/codex_thread.rs`                             | `CodexThread`                                 |
| Manager       | `core/src/thread_manager.rs`                           | `ThreadManager`, `ForkSnapshot`               |
| Protocol      | `protocol/src/protocol.rs`                             | `Submission`, `Op`, `EventMsg`, `RolloutItem` |
| Models        | `protocol/src/models.rs`                               | `ResponseItem` (incl. Reasoning)              |
| Tools plan    | `core/src/tools/spec_plan.rs`                          | `build_tool_router`                           |
| Tool registry | `core/src/tools/registry.rs`                           | `CoreToolRuntime`                             |
| Client        | `core/src/client.rs`                                   | `ModelClientSession`, compact endpoint        |
| AGENTS.md     | `core/src/agents_md.rs`                                | project instructions walk                     |
| Compact       | `core/src/compact.rs`, `compact_remote*.rs`            | auto/manual/remote                            |
| apply-patch   | `apply-patch/src/*`, `tools/handlers/apply_patch.rs`   | `seek_sequence`                               |
| Sandbox       | `sandboxing/`, `linux-sandbox/`, `windows-sandbox-rs/` | `SandboxManager`                              |
| Rollout       | `rollout/src/recorder.rs`                              | `RolloutRecorder`                             |
| Thread store  | `thread-store/src/store.rs`                            | `ThreadStore`                                 |
| App-server    | `app-server/`, `app-server-protocol/`                  | JSON-RPC methods                              |
| Exec-server   | `exec-server/`                                         | `process/start` PTY                           |
| CLI           | `cli/src/main.rs`                                      | `MultitoolCli`                                |
| TUI           | `tui/src/app.rs`                                       | ratatui app                                   |

---

## G. Full harness comparison

### G.1 Control loop

| Axis           | Babel                                            | Codex                                    | Who helps the same model more?                  |
| -------------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| Loop location  | `ChatEngine.submitMessageStream` for-loop        | `run_turn` sampling loop                 | Codex: clearer single engine                    |
| Stop condition | Model `finish` + **completion gates** may reject | Model done + **stop hooks** may continue | Babel for honesty; Codex for hook extensibility |
| Dual engines   | Chat + deep pipeline + lite residue              | One core Session path                    | **Codex** substrate clarity                     |
| Max iterations | `maxTurns` 200 default + task class              | Token/context + product limits           | Different budgets; not apples-to-apples         |
| Parallel tools | Up to 6 concurrent                               | Tool parallelism suite + orchestrator    | Codex deeper                                    |

**Babel should:** preserve gates; **reject** dual-engine for daily work; **adapt** single-loop discipline of Codex.

### G.2 Thread / turn / item / event models

| Concept     | Babel                         | Codex                                                     |
| ----------- | ----------------------------- | --------------------------------------------------------- |
| Thread      | threadStore id + event log    | `ThreadId` + ThreadManager                                |
| Turn        | user submission + inner turns | `TurnStarted`/`TurnComplete` EventMsg                     |
| Item        | history cells                 | `TurnItem` (UserMessage, FileChange, CommandExecution, …) |
| Model items | ProviderMessage / tool_calls  | `ResponseItem` incl. Reasoning encrypted                  |
| Rollout     | `ThreadEvent` JSONL-like log  | `RolloutItem` JSONL under `~/.codex/sessions`             |

**Parity need:** unify Babel event taxonomy toward stable call_id continuity (already partially present in `threadEventLog`).

### G.3 Context construction

| Axis                 | Babel                                                            | Codex                                    |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Project instructions | `chatStackCompile` loads AGENTS.md / Claude.md / PROJECT_CONTEXT | `agents_md.rs` walk + AGENTS.override.md |
| Repo orientation     | `repoMapPreamble`                                                | Environment + world state fragments      |
| Skills               | Stack compile + skills cmd                                       | first-class SkillsService + injection    |
| Plugins/hooks        | Limited hooks runtime                                            | Full hooks engine + plugins marketplace  |
| Budget               | char budgets (12k/24k stack) + token limits                      | token budget tools + compact             |

### G.4 Compaction

| Axis        | Babel                                                      | Codex                                               |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Strategy    | LLM summarize + heuristic fallback; **between turns only** | Local auto/manual + **remote** `/responses/compact` |
| Mid-turn    | No                                                         | Yes (token limit mid-turn)                          |
| Persistence | `compaction_capsule` in event log                          | `RolloutItem::Compacted` with window IDs            |
| Tests       | chatCompaction tests                                       | large compact_* suite + resume/fork after compact   |

**Babel should adapt:** mid-turn compaction eligibility + stronger capsule invariants; **not** depend on OpenAI remote compact (`[PROPRIETARY-BOUNDARY]`).

### G.5 Same-model effect summary (harness only)

Codex is more likely to keep the model productive under long sessions (compact, PTY, multi-agent, sandbox retries).
Babel is more likely to **refuse false completion** and surface env failures honestly.
**Net for ordinary SWE tasks:** Codex substrate + Babel honesty is the winning combination.

---

## H. Model / provider comparison

| Axis            | Babel                                                                       | Codex                                                      | Separation                                                          |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Primary API     | OpenAI-compatible chat completions + tools (`runners/deepInfraApi.ts` etc.) | Responses API (`/responses`, WS beta)                      | API affordance vs harness                                           |
| Multi-provider  | First-class                                                                 | Limited (`model-provider`, ollama/lmstudio crates)         | **Babel harness win**                                               |
| Reasoning items | Thought capture / stream deltas                                             | `ResponseItem::Reasoning` + `encrypted_content` round-trip | **Codex/provider win** `[PROPRIETARY-BOUNDARY]` for encrypted state |
| Compact API     | Local LLM summarize                                                         | Remote compact endpoint                                    | Provider                                                            |
| Sticky routing  | Standard HTTP                                                               | `x-codex-turn-state` headers                               | Provider/product                                                    |
| Tool schema     | OpenAI function tools + text-tool fallback                                  | Function + freeform apply_patch + tool_search + namespaces | Mix                                                                 |

**When exact same-model equality is impossible:**
Document provider/API differences; run **Track B** with OpenAI-compatible endpoint both sides if Codex supports non-OpenAI provider for that model; otherwise Track A native + explicit “not isolated harness” label.

---

## I. Tool-runtime comparison

### I.1 Inventory

| Capability      | Babel tools                                | Codex tools                                 | Notes                               |
| --------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------- |
| Read file       | `read_file`, `read_range`                  | via shell / unified_exec                    | Babel explicit; Codex shell-centric |
| List/glob/grep  | `list_dir`, `glob`, `grep`                 | shell + file-search UI                      | Babel clearer schemas               |
| Semantic search | `semantic_search`                          | shell / external                            | Babel HAS                           |
| Write           | `write_file`                               | apply_patch / shell                         |                                     |
| Exact replace   | `str_replace`                              | apply_patch hunks                           | Both; algorithms differ             |
| Patch           | `apply_patch` → write + `git apply`        | freeform `apply_patch` + `seek_sequence`    | **Codex stronger**                  |
| Shell           | `run_command`                              | `exec_command` / `shell_command`            |                                     |
| Background/PTY  | background flag + await; limited vs Docker | unified_exec PTY + write_stdin              | **Codex stronger**                  |
| Tests           | `test_run`                                 | shell                                       | Babel first-class name              |
| MCP             | client + server                            | client + server + resources                 | Codex deeper resources              |
| LSP             | `lsp` tool                                 | not primary                                 | **Babel HAS**                       |
| Web             | search/fetch                               | hosted web_search                           |                                     |
| Subagents       | `sub_agent`                                | multi-agent V1/V2 tools                     | **Codex deeper**                    |
| Plan            | deep/plan modes                            | `update_plan`                               |                                     |
| Permissions     | approval tools                             | `request_permissions`, `request_user_input` | Codex richer                        |
| Context tools   | budgets in engine                          | `get_context_remaining`, `new_context`      | Codex explicit                      |
| Plugins         | skills surface                             | install/list plugin tools                   | Codex                               |

### I.2 Dispatch quality

- **Codex:** ToolRouter + registry + pre/post hooks + parallel orchestrator + dispatch traces — production grade. `[SOURCE-VERIFIED]`
- **Babel:** chat tool names vs executor registry dual mapping (`read_file` vs `file_read`) — friction. `[SOURCE-VERIFIED]`

**Babel should:** unify tool naming; adapt lifecycle begin/end persistence before/after exec; keep explicit read/grep tools (do **not** copy shell-only file access as sole model surface).

---

## J. Editing and transaction comparison

| Axis              | Babel                                                   | Codex                                                                             |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Primary edit      | `governedStrReplace` exact; ambiguous multi-match fails | freeform patch + fuzzy `seek_sequence` (exact→rstrip→trim→unicode)                |
| apply_patch       | Validate size/hunks → write temp → `git apply`          | Dedicated crate + safety assess + sandbox FS                                      |
| Atomic multi-file | Checkpoint before mutations; not full 2PC               | Sequential multi-file; **partial apply leaves prior writes** (documented fixture) |
| Stale revision    | content mismatch only                                   | context miss; not full etag concurrency                                           |
| Crash mid-edit    | `patchRecovery` append log + checkpoints                | rollout + FS state; no universal rollback of partial patch                        |
| Approval          | policy presets + JIT                                    | patch approval ops + guardian                                                     |

**Crash/stale recommendations for Babel:**

1. Port **fuzzy seek** for apply_patch path (adapt algorithm; reimplement in TS or sidecar).
2. Record pre-image hashes per file in mutation events.
3. On multi-file apply, emit partial-failure receipt with applied set (honesty).
4. Keep governed str_replace exact semantics (predictable for models that emit exact strings).

---

## K. Environment-readiness comparison

| Axis              | Babel                                   | Codex                                                               |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Doctor            | `doctor.ts` multi-scope                 | `codex doctor` + install-context                                    |
| Dep readiness     | `workspaceDepPreflight` + optional venv | install-method detection; env selection / wait_for_environment tool |
| Missing toolchain | **`ENV_BLOCKED` terminal class**        | Model sees shell errors; less structured product terminal           |
| Windows           | Explicit portability CI + scripts       | windows-sandbox + install.ps1; daemon Unix-only                     |

**Generalized Babel opportunity:** expand preflight into a **workspace readiness planner** (language toolchain matrix + first failing command recipe) feeding the same model before thrashing.

---

## L. Verification and completion analysis

| Axis                   | Babel                                                    | Codex                                             |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Ordinary stop          | Model completion type                                    | Model no tool follow-up                           |
| Verified acceptance    | **Yes** — green authoritative verifier for execute class | **No universal gate** — hooks/stop only           |
| False-complete defense | ad-hoc scripts, inline probes, zero-write, critic        | Rely on model + optional guardian review          |
| Terminal honesty       | `completed` / `blocked` / budget / ENV_BLOCKED           | TurnComplete; product UX                          |
| Tests of honesty       | extensive agent tests                                    | fewer “must run npm test to finish” harness tests |

**Ordinary stop ≠ verified acceptance.**
Babel must not abandon gates when adopting Codex substrate.
Codex parity on UX stop is not the goal; **surpass** on verified completion.

---

## M. Persistence and recovery analysis

| Axis           | Babel                                         | Codex                                                   |
| -------------- | --------------------------------------------- | ------------------------------------------------------- |
| Event log      | `threadEventLog` versioned kinds              | `RolloutItem` JSONL                                     |
| Index/meta     | per-thread `meta.sqlite`                      | state DB + thread-store search                          |
| Resume         | session resume + rebuild messages from events | `thread/resume` + RolloutRecorder Resume                |
| Fork           | thread branch commands                        | `thread/fork` with turn cut                             |
| Rollback       | checkpoints/undo FS                           | `thread/rollback` (context only; deprecated path noted) |
| Subagent graph | sub_agent tasks                               | agent-graph-store parent/child                          |
| Crash mid-tool | weaker formalization                          | tool begin/end events + process manager                 |

**Restart boundaries:**

- Babel: tool results intended not re-executed on resume if log complete.
- Codex: same family; more tests on compact+fork+resume.

---

## N. CLI comparison

| Surface        | Babel                         | Codex                            |
| -------------- | ----------------------------- | -------------------------------- |
| Default        | Interactive REPL              | Interactive TUI                  |
| Headless       | chat-headless / workflow JSON | `codex exec` + jsonl processors  |
| Resume/fork    | slash + thread commands       | first-class CLI subcommands      |
| Doctor         | `babel doctor`                | `codex doctor`                   |
| Sandbox debug  | profiles / dry                | `codex sandbox` / debug-sandbox  |
| MCP            | config + server               | mcp + mcp-server + plugin        |
| App-server     | sketch                        | full                             |
| Exit contracts | mixed Commander               | structured exec event processors |

---

## O. TUI/REPL comparison

| Axis           | Babel                                                                                                                                 | Codex                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Stack          | Custom Node ANSI / conversational renderer                                                                                            | **ratatui** + crossterm              |
| Architecture   | REPL loop + slash commands                                                                                                            | AppEvent bus + embedded app-server   |
| Approvals UX   | chatApproval JIT                                                                                                                      | bottom_pane approvals                |
| Streaming      | answer_chunk / tool events                                                                                                            | history cells + streaming controller |
| Recommendation | Keep Node TUI short-term; evolve **trust-first** panes (claims, evidence, gate, why-stopped); optionally protocol-drive UI like Codex | —                                    |

---

## P. App-server / protocol comparison

### Codex (production)

- JSON-RPC-like (explicitly **not** full JSON-RPC 2.0 header) methods: `thread/start|resume|fork|…`, `turn/start`, items stream, approvals as server→client requests.
- Transports: stdio, websocket, unix socket; daemon Unix-only.
- Tests: large `app-server/tests/suite/v2/`.

### Babel (sketch)

```text
thread.create | thread.resume | turn.submit | turn.cancel | history.lookup
notifications: turn.event | cell.committed
```

`BABEL_PROTOCOL_VERSION = 1.0.0` but comment: **Phase D1 sketch**.

### Minimal Babel runtime protocol to reach practical client parity

1. `initialize` / capabilities
2. `thread.start|resume|list|fork`
3. `turn.start|cancel` + streaming events (tool_start/complete, file_changed, gate_rejected, env_blocked, done)
4. `approval.request` / `approval.resolve`
5. `history.list|lookup`
6. Optional: `checkpoint.list|restore`

**Do not** copy Codex method names blindly; map to Babel threadStore + ChatEngine.

---

## Q. Security and sandbox audit

| Control             | Babel                         | Codex                           | Gap                   |
| ------------------- | ----------------------------- | ------------------------------- | --------------------- |
| Path jail           | Yes                           | Yes (roots + profiles)          | Parity-ish            |
| Command allowlist   | Yes                           | Execpolicy Starlark             | Codex more expressive |
| `shell: false`      | Yes                           | OS sandbox often                | Different model       |
| OS process sandbox  | Docker **benchmark-oriented** | macOS/Linux/Windows first-class | **Large Codex lead**  |
| Network policy      | weak / profile                | network-proxy + approvals       | Codex                 |
| Secrets             | safeEnv helpers               | secrets crate + keyring         | Codex deeper          |
| Windows             | path + cmd.exe pattern        | windows-sandbox-rs RT/ACL/WFP   | Codex when enabled    |
| Malicious AGENTS.md | policy/stack compile          | same class risk; hooks/guardian | Shared risk           |

**Unknowns:** no fault-injection of sandbox escape attempted here.
**Repro tests Babel needs:** landlock/bwrap optional sidecar OR document intentional path-allowlist trust model for OSS daily use; never claim OS isolation without tests.

---

## R. Capability matrix

Legend: **HAS** | **PARTIAL** | **ABSENT** | **UNVERIFIED**

| Capability                    | Babel              | Codex OSS               | Evidence note             |
| ----------------------------- | ------------------ | ----------------------- | ------------------------- |
| Interactive coding TUI/REPL   | HAS                | HAS                     | Both source               |
| Autonomous file edit          | HAS                | HAS                     |                           |
| Explicit read/grep/glob tools | HAS                | PARTIAL (shell-primary) |                           |
| Freeform fuzzy apply_patch    | PARTIAL            | HAS                     | Babel git-apply path      |
| OS sandbox (default daily)    | PARTIAL            | HAS                     | Babel Docker optional     |
| Network policy proxy          | ABSENT             | HAS                     |                           |
| Session resume                | HAS                | HAS                     |                           |
| Session fork                  | PARTIAL            | HAS                     |                           |
| Compaction                    | HAS                | HAS                     | Codex + remote            |
| Mid-turn compact              | ABSENT             | HAS                     |                           |
| Completion verification gates | HAS                | ABSENT/PARTIAL          | Babel lead                |
| ENV_BLOCKED honesty           | HAS                | PARTIAL                 |                           |
| Multi-provider BYOM           | HAS                | PARTIAL                 |                           |
| App-server protocol           | PARTIAL (sketch)   | HAS                     |                           |
| Exec-server / remote env      | ABSENT             | HAS                     | remote proprietary        |
| Multi-agent graph             | PARTIAL            | HAS                     |                           |
| Skills                        | HAS                | HAS                     |                           |
| Plugins marketplace           | ABSENT             | HAS                     | server share proprietary  |
| Hooks engine                  | PARTIAL            | HAS                     |                           |
| MCP client                    | HAS                | HAS                     |                           |
| MCP server                    | HAS                | HAS                     |                           |
| PTY long-running              | PARTIAL            | HAS                     |                           |
| Headless JSON                 | PARTIAL            | HAS                     |                           |
| Windows first-class CI        | HAS                | HAS                     | daemon Unix-only on Codex |
| OTEL/analytics                | PARTIAL            | HAS                     | Codex Sentry DSN in OSS   |
| LSP tools                     | HAS                | ABSENT/UNVERIFIED       | Babel lead                |
| Prompt control plane          | HAS (out of scope) | ABSENT as product       | not scored heavily        |

---

## S. Failure-mode matrix

| Failure                       | Babel behavior                    | Codex behavior              | Babel action          |
| ----------------------------- | --------------------------------- | --------------------------- | --------------------- |
| Model false complete          | Gate reject / critic              | Turn complete               | **Preserve**          |
| Missing toolchain             | ENV_BLOCKED                       | Shell error thrash risk     | **Preserve / expand** |
| Patch context miss            | str_replace fail / git apply fail | fuzzy seek retries          | Adapt fuzzy           |
| Mid-stream cancel             | cancelled event                   | cancel tokens               | Harden                |
| Crash after mutate before log | patchRecovery partial             | rollout race residual       | Fault-inject          |
| Stale file concurrent edit    | content mismatch                  | context miss                | Pre-image hash        |
| Compaction drops tool pair    | invariant claimed                 | strong tests                | Add golden tests      |
| Sandbox deny                  | structured denial                 | sandbox + policy            | Optional OS sidecar   |
| Provider outage               | multi-provider fallback           | Responses retry/WS fallback | Keep multi-provider   |
| Malicious AGENTS.md           | stack load risk                   | same                        | Untrusted input guard |
| Subagent runaway              | max_rounds                        | graph + close_agent         | Adapt budgets         |
| Dual-engine drift             | chat vs deep inconsistency        | single core                 | Collapse daily path   |

---

## T. Weighted assessments

Weights from research prompt:

| Dimension                           | Weight | Leader                            | Score note (0–10 harness quality) | Confidence             |
| ----------------------------------- | ------ | --------------------------------- | --------------------------------- | ---------------------- |
| Coding-task completion reliability  | 17     | Codex                             | C 8 / B 6                         | Medium (no live bench) |
| Session and crash recovery          | 12     | Codex                             | C 8 / B 5.5                       | High arch              |
| Editing and patch reliability       | 10     | Codex                             | C 8 / B 6                         | High                   |
| Context quality and compaction      | 9      | Codex                             | C 8 / B 6                         | High                   |
| Verification and completion honesty | 12     | **Babel**                         | C 4 / B 8.5                       | High                   |
| Tool-runtime quality                | 8      | Codex                             | C 8.5 / B 6.5                     | High                   |
| Provider resilience and portability | 6      | **Babel**                         | C 5 / B 8                         | High                   |
| Environment readiness               | 5      | Babel edge                        | C 6 / B 7.5                       | Medium–High            |
| CLI and automation                  | 5      | Codex                             | C 8.5 / B 6.5                     | High                   |
| TUI/REPL usability                  | 5      | Codex                             | C 8 / B 6                         | Medium (subjective UX) |
| App-server and external clients     | 4      | Codex                             | C 9 / B 3                         | High                   |
| Security and permissions            | 3      | Codex                             | C 8.5 / B 5                       | High                   |
| Observability and evaluation        | 2      | Codex                             | C 7 / B 5                         | Medium                 |
| Test maturity                       | 2      | Codex volume / Babel policy depth | C 8 / B 7                         | Medium                 |

**Weighted sketch (not a live benchmark):** Codex ~7.4, Babel ~6.3 on substrate-heavy weighting; **with verification dimension stressed for product trust, Babel closes gap**. Treat scores as architecture priors pending §Z.

### Scenario table (selected)

| Scenario                    | Better harness today | Why                                               |
| --------------------------- | -------------------- | ------------------------------------------------- |
| Small bug fix               | Codex                | faster edit/exec loop                             |
| Multi-file feature          | Codex                | apply_patch + multi-agent                         |
| Task-class verifier gates   | **Babel**            | authoritative completion evidence                 |
| Missing Python deps         | **Babel**            | ENV_BLOCKED                                       |
| IDE integration             | Codex                | app-server                                        |
| Non-OpenAI model            | **Babel**            | providers                                         |
| Long session compact        | Codex                | remote+local compact tests                        |
| Windows daily coding        | Mixed                | Babel portable; Codex sandbox deeper when enabled |
| Resume after crash          | Codex                | rollout maturity                                  |
| Malicious repo instructions | Mixed                | both need untrusted guard; Codex hooks help       |

---

## U. Copy / adapt / reject / preserve / defer

| Item                                 | Decision                                         | Why                                      | Licensing note                                                                                                           |
| ------------------------------------ | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Single `run_turn`-class loop         | **Adapt**                                        | Collapse dual engines                    | Idea only                                                                                                                |
| Freeform apply_patch + seek_sequence | **Adapt** (reimplement)                          | Reliability                              | Apache-2.0 source may inspire; **do not copy verbatim without license review** — prefer clean-room algorithm description |
| OS sandbox stack                     | **Defer** full port; **adapt** optional sidecar  | Huge; path jail OK short-term            | Windows sandbox complexity                                                                                               |
| App-server method catalog            | **Adapt** minimal subset                         | IDE path                                 | Protocol design original                                                                                                 |
| Rollout JSONL + SQLite               | **Adapt** unify with threadEventLog              | Recovery                                 | —                                                                                                                        |
| Multi-agent V2                       | **Adapt** gradually                              | Power                                    | —                                                                                                                        |
| Remote Responses compact             | **Reject** as dependency                         | Proprietary                              | —                                                                                                                        |
| Shell-only file tools                | **Reject**                                       | Babel read tools better for small models | —                                                                                                                        |
| Completion without gates             | **Reject**                                       | Product identity                         | —                                                                                                                        |
| Multi-provider                       | **Preserve**                                     | Differentiator                           | —                                                                                                                        |
| ENV_BLOCKED + dep preflight          | **Preserve**                                     | Differentiator                           | —                                                                                                                        |
| Diff critic / verifier integrity     | **Preserve**                                     | Differentiator                           | —                                                                                                                        |
| Prompt OS layers                     | **Preserve** but keep out of daily loop hot path | Product                                  | —                                                                                                                        |
| Full Rust rewrite                    | **Reject** (now)                                 | Migration cost > gain; hybrid better     | —                                                                                                                        |
| Codex plugin marketplace             | **Defer**                                        | Needs backend                            | Proprietary bits                                                                                                         |
| Hooks engine                         | **Adapt** subset (pre/post tool, stop)           | Extensibility                            | —                                                                                                                        |
| PTY unified_exec                     | **Adapt**                                        | Long-running tasks                       | —                                                                                                                        |
| Guardian auto-reviewer               | **Defer**                                        | Optional later                           | May need model                                                                                                           |

---

## V. Migration strategy

### Four options

| Option                             | Description                                                       | Effort | Risk                          | Verdict                                          |
| ---------------------------------- | ----------------------------------------------------------------- | ------ | ----------------------------- | ------------------------------------------------ |
| **1. Status quo polish**           | Keep dual engines; patch gaps                                     | S–M    | Stagnation                    | Reject as strategy                               |
| **2. TypeScript substrate harden** | ChatEngine becomes sole daily runtime; adapt Codex patterns in TS | L      | Manageable                    | **Selected primary**                             |
| **3. Rust sidecar hybrid**         | Keep TS agent; native sandbox/exec/patch helpers                  | L–XL   | FFI/Windows packaging         | **Selected secondary** for sandbox/PTY if needed |
| **4. Rust rewrite / Codex fork**   | Replace babel-cli core                                            | XL     | Product freeze; dual identity | **Reject** unless 2 fails after 2–3 quarters     |

**Selected architecture:** Option **2 + selective 3**.
**Not:** full Codex fork (license+identity+OpenAI coupling).
**Compatibility:** feature-flag new tool lifecycle and protocol methods; keep ChatEngine public API stable.

---

## W. Dependency-ordered P0–P3 roadmap

### P0 — Substrate truth (4–8 weeks)

1. **Single daily runtime law** — document + enforce ChatEngine-only for ordinary coding; deep remains explicit.
2. **Durable tool lifecycle** — persist tool_request before exec; tool_result with stable call_id; crash resume golden tests.
3. **Unify tool names** — one schema surface for model + executor.
4. **apply_patch reliability** — fuzzy context match + partial-apply receipts (TS clean-room).
5. **Completion gate CI** — keep gates default-on for execute class; expand golden false-complete corpus.

### P1 — Protocol & recovery (6–10 weeks)

6. Expand app-server protocol past sketch (minimal set in §P).
7. Thread fork/resume parity tests matching Codex suite themes.
8. Mid-session compaction capsules with tool-pair invariants.
9. Background shell/PTY model improvement (or sidecar).
10. Trust-first TUI: why-stopped, gate, ENV_BLOCKED, evidence.

### P2 — Security & multi-agent (quarter)

11. Optional OS sandbox profile (Docker daily or native sidecar).
12. Execpolicy-like allow/prompt/forbid for shell.
13. Multi-agent graph store + budgets (adapt V2 concepts).
14. Hooks: pre/post tool + stop.
15. Network policy optional.

### P3 — Surpass layer (ongoing)

16. Evidence graph acceptance contracts.
17. Adaptive progress stopper (not only maxTurns).
18. Workspace readiness planner.
19. Same-model harness-normalized benchmark automation.
20. Fault-injection campaign harness.

---

## X. Fastest-path backlog (ordered issues)

| #   | Issue title                                                         | Class   | Depends | Effort | Acceptance gate                                   |
| --- | ------------------------------------------------------------------- | ------- | ------- | ------ | ------------------------------------------------- |
| 1   | Law: ChatEngine is sole ordinary coding path (docs + mode defaults) | Parity  | —       | S      | No interactive path lands in lite/deep by default |
| 2   | Tool call persist-before-exec + resume golden                       | Parity  | 1       | M      | Kill process mid-tool → resume no double mutate   |
| 3   | Unify chat tools ↔ executor registry                                | Parity  | 1       | M      | One name set in schema + tests                    |
| 4   | apply_patch fuzzy seek (clean-room)                                 | Parity  | 3       | L      | Fixture suite port of miss/near-miss cases        |
| 5   | Partial multi-file apply receipt                                    | Parity  | 4       | M      | Failure returns applied paths list                |
| 6   | Mid-turn compaction eligibility                                     | Parity  | 2       | M      | Capsule preserves tool pairs                      |
| 7   | Protocol v1.1: turn stream + approvals                              | Parity  | 2       | L      | External client drives one full turn              |
| 8   | Headless JSON event processor (exec-class)                          | Parity  | 7       | M      | CI consumes NDJSON events                         |
| 9   | PTY/background process manager                                      | Parity  | 3       | L      | await_command reliable e2e                        |
| 10  | Trust-first stop UX (gate/ENV/why)                                  | Surpass | 1       | M      | Snapshot tests for cards                          |
| 11  | Optional Docker sandbox profile for daily                           | Parity  | 3       | L      | Policy test denial cases                          |
| 12  | Execpolicy allowlist DSL                                            | Parity  | 11      | L      | Starlark-or-JSON rules tested                     |
| 13  | Agent graph store for subagents                                     | Parity  | 2       | M      | parent/child list API                             |
| 14  | Hooks pre/post/stop                                                 | Parity  | 2       | M      | Fixture hook can block finish                     |
| 15  | Workspace readiness planner v1                                      | Surpass | —       | M      | Blocks before mutate with recipe                  |
| 16  | Adaptive progress metric (writes/tests/coverage)                    | Surpass | 5       | M      | Stops thrash without false complete               |
| 17  | Fault-injection harness skeleton                                    | Surpass | 2       | L      | 5 injected failures classified                    |
| 18  | Same-model Track B runner (Babel vs Codex exec)                     | Surpass | 8       | L      | Shared task JSON + report                         |
| 19  | Collapse lite dead code paths (after 1)                             | Hygiene | 1       | M      | Import graph shows no interactive lite            |
| 20  | ADR set for decisions 1–5                                           | Process | 1       | S      | 5 ADRs merged                                     |

---

## Y. Surpass architecture

### Y.1 Acceptance contracts

Every execute-class turn ends with one of:

- `VERIFIED_COMPLETE` — authoritative green tests + non-empty honest patch when required
- `ENV_BLOCKED` — missing toolchain/deps (not agent failure)
- `POLICY_BLOCKED` — sandbox/approval
- `BUDGET_EXHAUSTED`
- `FAILED_WITH_EVIDENCE` — tests red / critic reject
- `CANCELLED`

### Y.2 Evidence graph

Nodes: user goal, files read, mutations (pre/post hash), commands, test receipts, critic verdicts, gate decisions.
Edges: causal. UI and resume rebuild from graph.

### Y.3 Readiness

Preflight plan before first mutate: language, package manager, test command, missing deps.

### Y.4 Adaptive progress

Stop when no new files/tests/coverage for N turns **unless** gate requires verify — then prefer `FAILED_WITH_EVIDENCE` over fake complete.

### Y.5 Durable multi-agent

Subagents write only into declared scopes; parent merges with conflict receipts; graph store survives restart.

---

## Z. Benchmark and fault-injection plan

### Z.1 Same-model validity

| Track                    | Purpose              | Setup                                                                    |
| ------------------------ | -------------------- | ------------------------------------------------------------------------ |
| **A Native**             | Real product quality | Babel default vs `codex exec` default                                    |
| **B Harness-normalized** | Isolate harness      | Same model id if possible; equalize tools/permissions/budget/repo commit |

If Codex cannot use non-OpenAI model X: Track B limited; state explicitly.

### Z.2 Controls

Hold constant: model revision, temperature, max tokens, repo SHA, task text, container image, CPU/RAM, network policy, attempt count, initial git status.

### Z.3 Task categories (minimum pilot)

Small bug, multi-file bug, type error, test repair, missing dep, long-context, patch conflict, stream interrupt, resume after kill, malicious AGENTS.md, Windows path task.

### Z.4 Metrics

Pass rate, verified pass rate, false-complete rate, empty-patch rate, env false-block rate, recovery success, tokens/cost/wall per pass, gate coverage.

### Z.5 Fault injection

Kill before/after tool persist; mid-stream cancel; multi-file partial apply; compaction during tool pair; sandbox deny; provider 500.

### Z.6 Trajectory classification

Model / context / tool schema / edit engine / env / policy / verify / persistence / sandbox / protocol / benchmark infra.

**Experimental unit = complete product configuration, not model name alone.**

---

## AA. Architecture decision records (concise)

### ADR-X1 — Single daily runtime: ChatEngine

- **Context:** Dual Chat/deep/lite confuses product and recovery.
- **Decision:** Ordinary coding uses ChatEngine only.
- **Alternatives:** Keep dual; rewrite in Rust.
- **Consequences:** Deep remains explicit governance path.
- **Migration:** Mode defaults + deprecation warnings.
- **Rollback:** Feature flag.
- **Validation:** Interactive e2e never enters lite.

### ADR-X2 — Preserve completion honesty gates

- **Context:** Codex completes on model stop.
- **Decision:** Execute-class requires authoritative verify policy (configurable per task class).
- **Alternatives:** Optional gates only.
- **Consequences:** Lower false-complete; more ENV_BLOCKED.
- **Migration:** Already largely present — lock as invariant.
- **Rollback:** Task class `loose`.
- **Validation:** Golden false-complete suite.

### ADR-X3 — Hybrid TypeScript core; no full Rust rewrite

- **Context:** Codex substrate is Rust-shaped.
- **Decision:** Port patterns, not language, first.
- **Alternatives:** Codex fork; pure Rust rewrite.
- **Consequences:** Faster shipping; may need sidecars later.
- **Migration:** P0–P1 TS; P2 sidecar optional.
- **Rollback:** N/A.
- **Validation:** Parity metrics Track B.

### ADR-X4 — Expand app-server protocol to production minimal set

- **Context:** Protocol is D1 sketch; blocks IDE.
- **Decision:** Implement §P minimal methods on ChatEngine + threadStore.
- **Alternatives:** Shell-out to Codex app-server; only REPL.
- **Consequences:** New client contract.
- **Migration:** Versioned protocol; dual-run tests.
- **Rollback:** Keep sketch behind flag.
- **Validation:** External client full turn.

### ADR-X5 — Edit engine: keep str_replace; upgrade apply_patch

- **Context:** Codex fuzzy patch vs Babel exact replace.
- **Decision:** Keep exact str_replace; reimplement fuzzy apply_patch clean-room.
- **Alternatives:** Shell-only edits; copy Codex crate.
- **Consequences:** Dual edit tools with clear prompts.
- **Migration:** Feature flag fuzzy matcher.
- **Rollback:** git-apply only.
- **Validation:** apply_patch fixture suite.

---

## AB. Final recommendation table

| Priority | Change                       | Parity or surpass | Same-model impact | Effort | Dependency  | Migration               | Acceptance gate       |
| -------- | ---------------------------- | ----------------- | ----------------- | ------ | ----------- | ----------------------- | --------------------- |
| P0       | Single ChatEngine daily path | Parity            | High              | S      | —           | Mode defaults           | Interactive path test |
| P0       | Tool lifecycle durable log   | Parity            | High              | M      | P0 path     | Event log v2            | Crash resume golden   |
| P0       | Unify tool names             | Parity            | Medium            | M      | —           | Alias layer then delete | Schema single source  |
| P0       | Fuzzy apply_patch            | Parity            | High              | L      | Unify tools | Flag                    | Fixtures pass         |
| P0       | Lock completion gates        | Surpass           | High              | S      | —           | Policy invariant        | False-complete suite  |
| P1       | Protocol v1.1                | Parity            | Medium            | L      | Lifecycle   | Versioned               | Client e2e            |
| P1       | Mid-turn compaction          | Parity            | Medium            | M      | Lifecycle   | Capsules                | Tool-pair golden      |
| P1       | PTY/background manager       | Parity            | Medium            | L      | Tools       | Process table           | await e2e             |
| P1       | Trust-first stop UX          | Surpass           | Medium            | M      | Gates       | UI                      | Snapshots             |
| P2       | Optional OS sandbox          | Parity            | Medium            | XL     | Tools       | Profile                 | Denial tests          |
| P2       | Multi-agent graph            | Parity            | Medium            | L      | Lifecycle   | Store                   | Graph API tests       |
| P2       | Hooks subset                 | Parity            | Low–Med           | M      | Lifecycle   | Config                  | Hook blocks finish    |
| P3       | Readiness planner            | Surpass           | High              | M      | Preflight   | Service                 | Blocks thrash         |
| P3       | Adaptive progress            | Surpass           | High              | M      | Gates       | Metric                  | Thrash scenarios      |
| P3       | Same-model Track B           | Surpass           | Meta              | L      | Headless    | CI job                  | Report artifact       |
| P3       | Fault-injection harness      | Surpass           | Meta              | L      | Lifecycle   | Suite                   | 5 faults classified   |

---

## AC. Strategic conclusion

**Should Babel become a Codex-like general coding-agent runtime with stronger verification, or preserve a materially different execution architecture?**

**Recommendation:** Become a **Codex-like general coding-agent runtime substrate** (single durable loop, stronger tools/persistence/protocol/sandbox/recovery) **while preserving Babel’s materially different verification and honesty architecture** (authoritative completion, ENV_BLOCKED, critic, multi-provider).

Do **not** preserve dual-engine compensation forever.
Do **not** full-rewrite in Rust or fork Codex as the product.
Do **not** drop gates to chase “turn complete” UX parity.

**From source evidence, not positioning:**
Codex OSS shows what a production coding-agent **execution substrate** looks like (`run_turn`, rollout, app-server, sandboxes, apply_patch, multi-agent).
Babel already shows what a production coding-agent **acceptance layer** looks like (`completionGatePolicy`, `verifierIntegrity`, `implementorPolicy`, dep preflight).
The fastest path to leadership is **substrate catch-up + honesty keep**, measured by same-model Track B pass rate **and** false-complete rate—not stars, not Prompt OS, not feature counts.

---

## Appendix A — Example evidence citations

### Codex tool request/result continuity (pattern)

```
[SOURCE-VERIFIED] [TEST-VERIFIED]
Codex records model ResponseItems and tool outputs into history/rollout with call identities,
and dispatches tools through ToolRouter/CoreToolRuntime with pre/post hooks.

Evidence:
- Repository: openai/codex
- Commit: feee0b07c7564455e253312e62e6dba69dc861d3
- Files: codex-rs/core/src/session/turn.rs (run_turn),
         codex-rs/core/src/tools/registry.rs (CoreToolRuntime),
         codex-rs/rollout/src/recorder.rs
- Runtime path: client Op::UserInput → RegularTask → run_turn → stream → ToolRouter → rollout append
```

### Babel completion honesty

```
[SOURCE-VERIFIED] [TEST-VERIFIED]
Babel refuses to treat ad-hoc _verify*.py / shell junk as authoritative completion for execute work.

Evidence:
- Repository: gthgomez/Babel
- Commit: 63c394206c2d1d7f8420553e91db3625b09c3d62
- File: babel-cli/src/agent/completionGatePolicy.ts
- Symbols: isAuthoritativeVerifierCommand, isAgentOwnedAdHocVerifier, isInlineProbeVerifier
- Runtime path: ChatEngine finish → completion gate → reject or allow
- Tests: agent/*completionGate*, chatEngine*, implementor* suites
```

### Babel app-server sketch

```
[SOURCE-VERIFIED]
Babel protocol is Phase D1 sketch only.

Evidence:
- babel-cli/src/protocol/types.ts — BABEL_PROTOCOL_METHODS (5 methods)
- docs/adr/ADR-010-app-server-protocol.md
```

### Codex public boundary

```
[PROPRIETARY-BOUNDARY] [SOURCE-VERIFIED]
Remote environment registry / ChatGPT backend APIs are client-present but server-owned.
- codex-rs/chatgpt/, cloud-tasks*, exec-server remote Noise relay
```

---

## Appendix B — What not to build

1. A second interactive engine “for power users” without deleting the first.
2. Remote OpenAI compact as a hard dependency.
3. Shell-only file access as the sole model tool surface.
4. Completion without authoritative verification for execute-class SWE.
5. Claiming OS sandbox parity without platform tests.
6. Full monorepo rewrite “because Codex is Rust.”
7. Marketplace/cloud tasks clones without a backend strategy.
8. Marketing feature matrices without Track B metrics.

---

## Appendix C — Next operator actions

1. Convert §X rows 1–10 into GitHub issues (one PR wave = P0).
2. Land ADR-X1…X5 under `docs/adr/`.
3. Implement Track B pilot (5 tasks) Babel chat-headless vs `codex exec`.
4. Do **not** treat this document as license clearance to copy Codex source—clean-room adapt only.

---

_End of report. Research date 2026-08-01. Baselines: Babel `63c3942`, Codex `feee0b0`._
