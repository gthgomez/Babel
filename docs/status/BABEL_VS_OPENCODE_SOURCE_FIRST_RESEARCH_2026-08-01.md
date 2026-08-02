<!--
status: ACTIVE
last_verified: 2026-08-01
-->

# Source-First Research: OpenCode vs Babel Coding-Agent Architecture

**Research execution date:** 2026-08-01
**Mode:** Source-code-grounded systems research (not marketing, not Prompt OS, not GitHub-star comparison)
**Same-model unit of analysis:** Babel harness + model X vs OpenCode harness + **the same** model X
**Audience:** Babel maintainers converting findings into ADRs, migration waves, GitHub issues, fault-injection campaigns, and controlled same-model benchmarks
**Related:** [BABEL_VS_CODEX_OSS_RUNTIME_ARCHITECTURE_2026-08-01.md](./BABEL_VS_CODEX_OSS_RUNTIME_ARCHITECTURE_2026-08-01.md), [BABEL_VS_GROK_BUILD_HARNESS_2026-08-01.md](./BABEL_VS_GROK_BUILD_HARNESS_2026-08-01.md), [ADR-010-app-server-protocol.md](../adr/ADR-010-app-server-protocol.md)

**Evidence labels:** `[SOURCE-VERIFIED]` `[TEST-VERIFIED]` `[DOCUMENTED]` `[HISTORY-VERIFIED]` `[INFERRED]` `[UNKNOWN]` `[CONFLICT]` `[RUNTIME-VERIFIED]` `[PROPRIETARY-BOUNDARY]`

**Research limits (honest):**

- Full same-model benchmark (Tracks A–D in §Y) **not run** in this pass — design only.
- Fault-injection campaign **not run** — design only.
- OpenCode **local checkout is stale** relative to remote tip (see §B.2); primary analysis uses local tree at `bce2992` (package `1.18.4`) plus remote metadata for tip/release.
- Hosted OpenCode Console / Zen / share backends treated as optional product surface, not local OSS harness.
- No claim that OpenCode’s provider abstraction yields identical model behavior across vendors without proxy capture.

---

## A. Executive decision

| Question                                                 | Verdict                                                                                                                                                                                                                                     | Confidence                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Everyday coding** (understand repo → mutate → iterate) | **OpenCode leads** — unified session loop (`SessionPrompt.runLoop`), mature tool suite, shadow-git snapshots, SQLite message/parts, client/server TUI, ACP, plugins                                                                         | High architecture; medium on live same-model pass rates (not run) |
| **Verified / governed completion honesty**               | **Babel leads** — task-class verification policy, authoritative verifier commands, ad-hoc `_verify*` / `python -c` rejection, zero-write policy, diff critic, Windows verifier fail-fast                                                    | High                                                              |
| **Provider portability**                                 | **OpenCode leads for breadth** (AI SDK + models.dev catalog + many bundled providers); **Babel competitive for BYOM API runners** (DeepSeek/DeepInfra/Ollama/OpenRouter/etc.) but chat runner typing is narrower than its full runner set   | High on OpenCode surface; medium on equalized same-model quality  |
| **Recovery / state durability**                          | **OpenCode leads** — SQLite sessions/messages/parts, snapshot/revert, run-state, subagent child sessions; Babel has real transcript + thread event log + patch recovery + daemon crash recovery, but thinner tool-lifecycle durability      | High                                                              |
| **Environment readiness honesty**                        | **Babel leads** — workspace dep preflight, `ENV_BLOCKED` class, doctor, project test discovery; OpenCode relies on agent `bash` + project bootstrap without an equivalent first-class terminal honesty class                                | Medium–High                                                       |
| **CLI / headless**                                       | **OpenCode leads** — `run`, `serve`, `attach`, export/import, rich yargs surface                                                                                                                                                            | High                                                              |
| **TUI**                                                  | **OpenCode leads** — OpenTUI + worker/server split; Babel has real custom ANSI REPL + rich slash surface but in-process engine coupling                                                                                                     | High                                                              |
| **Server / client architecture**                         | **OpenCode leads by a wide margin** — embedded HTTP API + V2 protocol/SDK; Babel protocol is Phase D1 sketch (ADR-010)                                                                                                                      | High                                                              |
| **Extensibility**                                        | **OpenCode leads** — plugins, skills, MCP, commands, agent definitions, ACP                                                                                                                                                                 | High                                                              |
| **Largest Babel bottleneck**                             | **Execution substrate under the policy stack** — dual ChatEngine vs deep pipeline, sketch app-server, no shadow-git snapshot/revert loop, weaker PTY/server productization, in-process TUI, incomplete single durable tool-settlement model | High                                                              |
| **Largest OpenCode bottleneck**                          | **Completion honesty** — done when model finish + no open tools; no authoritative green-test gate; mid-flight V1→V2 dual runtime increases complexity; Bun-first ops friction for Node-only shops                                           | High                                                              |
| **Largest Babel advantage**                              | Verification/terminal honesty + Windows-first portability + environment readiness                                                                                                                                                           | High                                                              |
| **Largest OpenCode advantage**                           | Product-grade general coding runtime (session DB, tools, server, multi-client, providers, snapshots)                                                                                                                                        | High                                                              |
| **Fastest parity path**                                  | **Do not rewrite Babel as OpenCode.** Keep TypeScript ChatEngine as daily runtime; **adapt** OpenCode concepts (durable parts, server protocol, snapshot/revert, permission UX, tool lifecycle) while **preserving** Babel gates            | High                                                              |
| **Best surpass strategy**                                | **OpenCode-like substrate + Babel acceptance contracts** (evidence graph, authoritative verify, ENV_BLOCKED, progress-based stop, independent verifier)                                                                                     | High                                                              |
| **Recommended migration**                                | **Direction C/D hybrid — Layered selective convergence** (OpenCode-like execution substrate under Babel verification/governance). Reject full rewrite (A pure) and pure isolation (B pure)                                                  | High                                                              |

**Strategic answer (preview of §AB):**
Babel should **not** become a clone of OpenCode, and should **not** preserve a permanently weaker substrate while stacking more policy. It should converge on an **OpenCode-like general coding-agent runtime** (single durable loop, better persistence, client/server, snapshots, provider-normalized tools) **under** a **Babel-native verification and acceptance layer** that OpenCode does not have. Same-model reliability superiority is defensibly won on honesty + recovery + environment readiness—not on feature count.

---

## B. Repository baselines

### B.1 Babel (`gthgomez/Babel`)

| Field           | Value                                                                                                     | Evidence                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Repository role | Public canonical Babel checkout                                                                           | workspace                                     |
| Remote          | `https://github.com/gthgomez/Babel.git`                                                                   | `[SOURCE-VERIFIED]`                           |
| Default branch  | `main`                                                                                                    | `[SOURCE-VERIFIED]`                           |
| Commit SHA      | `63c394206c2d1d7f8420553e91db3625b09c3d62`                                                                | `[SOURCE-VERIFIED]`                           |
| Commit date     | 2026-08-01 01:29:21 -0500                                                                                 | `[SOURCE-VERIFIED]`                           |
| Subject         | Merge PR #42 `fix/c2-workspace-dep-preflight`                                                             | `[SOURCE-VERIFIED]`                           |
| Tag / describe  | `v0.1.0-63-g63c3942`                                                                                      | `[SOURCE-VERIFIED]`                           |
| CLI package     | `babel-cli` **0.1.0** (bin reports `1.0.0` in dist — **[CONFLICT]** package.json vs built version string) | package.json + `node dist/index.js --version` |
| License         | MIT                                                                                                       | `LICENSE`                                     |
| Runtime         | **Node ≥ 22.5.0** (not Bun)                                                                               | `engines.node`                                |
| Bins            | `babel`, deprecated stubs `babel-lite` / `bl`                                                             | package.json                                  |
| Structure       | Control-plane prompts + `babel-cli/` TypeScript runtime                                                   | CLAUDE.md                                     |
| Tests           | **386** `*.test.ts` under `babel-cli/src`; **73** under `agent/`                                          | count 2026-08-01                              |
| OS research env | Windows 11, PowerShell, Node v24.12.0, npm 11.7.0, Bun 1.3.11 present but not product runtime             | local env                                     |

**Canonical everyday path:** ChatEngine (`chat` / interactive / `chat-headless`).
**Governed path:** `plan` / `deep` → `runBabelPipeline`.
**Deprecated product surface:** separate lite bins (code remains).

### B.2 Active OpenCode (`anomalyco/opencode`)

| Field                                    | Value                                                             | Evidence                                                   |
| ---------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Research source                          | OpenCode comparison checkout                                      | local corpus reference; path intentionally omitted         |
| Remote                                   | `https://github.com/anomalyco/opencode.git`                       | `[SOURCE-VERIFIED]`                                        |
| Homepage                                 | https://opencode.ai                                               | GitHub API                                                 |
| Default branch                           | **`dev`** (not `main`)                                            | `[SOURCE-VERIFIED]` GitHub API                             |
| **Remote tip SHA**                       | `32f278b48f1a495611165d8a9f1ace0b512933e2`                        | 2026-08-01T14:25:21Z                                       |
| **Local checkout SHA (analyzed)**        | `bce2992729a9e0f1fe6dc3afa40f62004ab7a672`                        | 2026-07-24 — **stale vs tip**                              |
| Local package version                    | `1.18.4` (`packages/opencode`, `packages/core`)                   | package.json                                               |
| Latest stable release                    | **`v1.18.11`** (2026-08-01T11:44:45Z)                             | GitHub releases                                            |
| Pre-release noted                        | `pr-38252-videos` (verification videos)                           | release list                                               |
| License                                  | MIT                                                               | GitHub + LICENSE                                           |
| Languages                                | TypeScript monorepo; **Bun-first** (`packageManager: bun@1.3.14`) | root package.json                                          |
| Stars / size (context only; not scoring) | ~192k stars, large monorepo                                       | API snapshot 2026-08-01 — **not used for recommendations** |
| Dual SQLite                              | `sqlite.bun.ts` + `sqlite.node.ts`                                | core database                                              |
| Test files (approx)                      | **630** `*.test.ts` under `packages/`                             | local count                                                |
| Hosted extras                            | Console, share, stats, enterprise, SST infra                      | `infra/`, `packages/console` — optional                    |

**CLI-reported version:** not executed in this pass for remote binary (`[UNKNOWN]` vs local package `1.18.4`).
**Source version conflict:** local tree `1.18.4` / SHA `bce2992` vs release `v1.18.11` / tip `32f278b` — findings marked where tip may have advanced.

### B.3 Historical OpenCode (`opencode-ai/opencode`)

| Field               | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| Status              | **Archived**                                                  |
| Description         | “A powerful AI coding agent. Built for the terminal.”         |
| Default branch      | `main`                                                        |
| Last push           | 2025-09-18                                                    |
| Role in this report | **Historical provenance only** — excluded from parity scoring |

### B.4 Build / research environment

| Item                                     | Value                                             |
| ---------------------------------------- | ------------------------------------------------- |
| Research OS                              | Windows                                           |
| Shell                                    | PowerShell                                        |
| Node                                     | v24.12.0                                          |
| npm                                      | 11.7.0                                            |
| Bun                                      | 1.3.11 (available; OpenCode product is Bun-first) |
| Babel build                              | dist present; version string conflict noted       |
| OpenCode local install/run of full agent | **not** fully re-executed end-to-end in this pass |

---

## C. OpenCode disambiguation

| Entity                                              | Role                                                    | Include in parity?                                                                 |
| --------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **anomalyco/opencode**                              | Active OSS product (opencode.ai, CLI, TUI, server, SDK) | **Yes**                                                                            |
| **opencode-ai/opencode**                            | Archived predecessor                                    | Historical only                                                                    |
| **anomalyco/opentui**                               | TUI library dependency                                  | Dependency, not product under test                                                 |
| **awesome-opencode**, courses, samples              | Ecosystem noise                                         | No                                                                                 |
| **opencodex** / unrelated “Open Code” / “OpenCoder” | Name collisions                                         | No                                                                                 |
| **OpenCode Console / share / Zen-ish hosted paths** | Optional hosted services                                | Separate from local harness scoring                                                |
| **V1 SessionPrompt vs V2 SessionRunner**            | Dual internal runtimes in one monorepo                  | Score **what product actually invokes** (V1 primary for CLI/TUI; V2 mid-migration) |

---

## D. Architecture maps

### D.1 OpenCode (active)

```
User
 ├─ opencode (bin) → platform binary / bun src/index.ts
 │    ├─ $0 TUI ── worker process ── embedded Server ── SessionPrompt.loop (V1)
 │    ├─ run (headless) ── SessionPrompt
 │    ├─ serve / attach ── HTTP API
 │    └─ acp / mcp / session / providers / models …
 ├─ packages/core — SQLite, tools V2, SessionRunner (V2), providers, PTY
 ├─ packages/llm — canonical stream protocol drivers
 ├─ packages/server + protocol + sdk — external clients
 ├─ packages/tui / app / desktop / web — multi-surface clients
 └─ packages/plugin — extensibility

Trust boundary:
  Client (TUI/web) ──RPC/HTTP──> Server process (agent + tools + FS + shell)
  Permissions: allow | ask | deny (interactive deferred)
  Snapshots: shadow git under data/snapshot/{project}/{hash}
  Optional cloud: share, console, models.dev catalog fetch
```

### D.2 Babel

```
User
 ├─ babel (bin) → Node dist/index.js
 │    ├─ bare / "task" ── BabelRepl / chatCore ── ChatEngine (in-process)
 │    ├─ plan / deep ── runBabelPipeline (V9 stages)
 │    ├─ resume / undo / doctor / mcp
 │    └─ daemon (optional IPC queue; pipeline can fall back local)
 ├─ protocol/* ── Phase D1 sketch (types; not full product server)
 ├─ bridge/sessionServer ── experimental IDE HTTP/WS
 └─ control-plane prompts (catalog) — orthogonal to harness scoring

Trust boundary:
  TUI + ChatEngine co-located in one Node process (default)
  SafeExecutor path allowlist + command allowlist (not OS sandbox by default)
  Docker sandbox optional for benchmark profile
  Sessions: runs/chat-sessions/{id}/ + thread store
```

### D.3 Trust comparison (short)

| Boundary            | OpenCode                               | Babel                                    |
| ------------------- | -------------------------------------- | ---------------------------------------- |
| UI vs agent process | Split (worker/server) default          | Coupled default                          |
| FS mutation         | Tool + permission + external_directory | SafeExecutor root fence + approvals      |
| OS isolation        | Not default container NS               | Optional Docker benchmark profile        |
| Credential store    | core credential + auth plugins         | env / local config (public repo hygiene) |
| Hosted trust        | share/console optional                 | N/A product                              |

---

## E. Canonical runtime paths

### E.1 OpenCode everyday coding

1. `opencode` → TUI worker → instance Server
2. User prompt → `SessionPrompt.prompt` / `loop`
3. `runLoop` while: load compacted history → subtask/compaction/overflow or LLM step
4. `SessionProcessor.process` streams model → tool execute / permission.ask
5. Exit when assistant finish is terminal **and** no pending local tool calls
6. Persist messages/parts to SQLite; optional snapshot track

**Headless:** `opencode run` uses same session stack.
**V2 path:** `SessionExecution` → `SessionRunner.run` (core) — partial parity checklist still open in source comments.

### E.2 Babel everyday coding

1. `babel` / `babel "task"` → chat path
2. `compileChatStack` + identity (`AGENTS.md`/`CLAUDE.md`) + memory
3. `ChatEngine.submitMessageStream` → provider turn → tool_calls (≤6) or completion
4. `executeActionWithPolicy` → `localTools` / `sandbox.SafeExecutor`
5. **Completion gate** (and optional diff critic) may reject “done”
6. Persist transcript + thread events under `runs/chat-sessions/`

**Deep:** opt-in multi-stage pipeline with evidence bundles — not the default interactive path.

---

## F. File-and-symbol map (critical)

### F.1 OpenCode

| Subsystem      | Path                                            | Symbols                            |
| -------------- | ----------------------------------------------- | ---------------------------------- |
| CLI entry      | `packages/opencode/src/index.ts`                | yargs commands                     |
| Agent loop V1  | `…/session/prompt.ts`                           | `SessionPrompt.loop`, `runLoop`    |
| Stream/tools   | `…/session/processor.ts`                        | `Result = compact\|stop\|continue` |
| LLM V1         | `…/session/llm.ts`                              | AI SDK stream                      |
| Tools registry | `…/tool/registry.ts`, `read/edit/write/shell/…` | tool IDs                           |
| Built-ins V2   | `packages/core/src/tool/builtins.ts`            | ApplyPatch, Bash, Edit, …          |
| Runner V2      | `packages/core/src/session/runner/llm.ts`       | `SessionRunner.run`                |
| Compaction     | `…/session/compaction.ts`                       | prune constants, process           |
| Instructions   | `…/session/instruction.ts`                      | AGENTS.md, CLAUDE.md               |
| Snapshot       | `…/snapshot/index.ts`                           | track/restore/revert               |
| Permission     | `…/permission/*`, core `permission.ts`          | ask/assert/reply                   |
| Server         | `…/server/server.ts`, routes `httpapi/*`        |                                    |
| Protocol       | `packages/protocol`                             | HttpApi groups                     |
| DB             | `packages/core/src/database/*`                  | SQLite path                        |
| ACP            | `packages/opencode/src/acp/*`                   |                                    |
| Plugin         | `packages/plugin`                               |                                    |

### F.2 Babel

| Subsystem          | Path                                     | Symbols                                                             |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------- |
| CLI                | `babel-cli/src/index.ts`, `commands/*`   | Commander                                                           |
| Chat loop          | `agent/chatEngine.ts`                    | `ChatEngine`                                                        |
| Tools schema       | `agent/chatToolDefinitions.ts`           | `ChatToolActionSchema`, `buildChatToolDefinitions`                  |
| Executor           | `agent/toolExecutor.ts`, `localTools.ts` |                                                                     |
| Sandbox            | `sandbox.ts`                             | `SafeExecutor`                                                      |
| Completion gate    | `agent/completionGatePolicy.ts`          | `evaluateCompletionGateForEngine`, `isAuthoritativeVerifierCommand` |
| Compaction         | `agent/chatCompaction.ts`                | `CompactionManager`                                                 |
| Identity stack     | `agent/chatStackCompile.ts`              | `IDENTITY_CANDIDATES`                                               |
| Resume             | `interactive/chatSessionResume.ts`       | `resumeChatSession`                                                 |
| Background shell   | `agent/backgroundShell.ts`               |                                                                     |
| Diff critic        | `agent/diffCritic.ts`                    |                                                                     |
| Verifier fail-fast | `agent/verifierFailFast.ts`              | Windows NTSTATUS                                                    |
| Pipeline           | `pipeline.ts`                            | `runBabelPipeline`                                                  |
| Protocol sketch    | `protocol/types.ts`                      | `BABEL_PROTOCOL_VERSION`                                            |
| Daemon recovery    | `daemon/recovery.ts`                     | `runCrashRecovery`                                                  |
| Providers          | `runners/*`, `modelPolicy.ts`            |                                                                     |

---

## G. Full harness comparison

### G.1 Agent loop

| Axis            | OpenCode                                             | Babel                                                | Same-model effect                                    |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Loop shape      | While-true until finish + no tools                   | Turn loop until model completion **and** gate allows | Babel may force more tool turns after false “done”   |
| Step bound      | Agent `steps` + max-steps prompt                     | Chat limits / budget kill / stall detectors          | Both bound runaway; different UX                     |
| Dual runtime    | V1 product + V2 rewrite mid-flight                   | ChatEngine + deep pipeline                           | Both risk path confusion                             |
| Tool call model | Native provider tools (AI SDK) + durable settle (V2) | Structured chat tools + text-tool parser fallback    | Continuity differs by provider adapter quality       |
| Doom loop       | 3 identical tool calls → permission `doom_loop`      | Repetition/stall detectors + blocked attempt ledger  | Both; OpenCode permission-gated, Babel policy-logged |

### G.2 Session & messages

| Axis           | OpenCode                                                       | Babel                                           |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Primary store  | SQLite messages + typed **parts**                              | Transcript JSONL + thread cells/event log       |
| Part types     | text, reasoning, tool, snapshot, patch, compaction, subtask, … | ChatMessage + tool results; event log for IDs   |
| Child sessions | `task` tool + `parentID`                                       | Nested ChatEngine / worktree implement subagent |
| Fork           | TUI fork-from-timeline                                         | `threadStore/branching.forkThread`              |
| Busy control   | SessionRunState / SessionRunCoordinator                        | TurnRuntime + abort                             |

### G.3 Provider / model

| Axis              | OpenCode                                            | Babel                                                 |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Abstraction       | Provider service + AI SDK + models.dev catalog      | Runner classes + modelPolicy tiers                    |
| Native tools      | First-class stream tool calls                       | Native when runner supports; text tool parse fallback |
| Capability filter | Model-specific tool sets (e.g. apply_patch for GPT) | Phase tool policy + task class                        |
| Same-model caveat | Provider transform can change behavior              | Runner choice can change behavior                     |

### G.4 Context / compaction

| Axis           | OpenCode                                                     | Babel                                                                    |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Instructions   | AGENTS.md / CLAUDE.md / config.instructions / nested resolve | AGENTS.md / Claude.md / CLAUDE.md + chat stack compile + BABEL.md memory |
| Token estimate | ~chars/4                                                     | estimateTokens in chatCompaction                                         |
| Compaction     | Structured compaction turns + prune tool outputs             | LLM summarize + heuristic fallback                                       |
| Overflow       | Token usable window vs last assistant tokens                 | Trigger ~100k tokens config                                              |

### G.5 Tools (existence)

| Tool class                | OpenCode                                 | Babel                                       |
| ------------------------- | ---------------------------------------- | ------------------------------------------- |
| Read / list / grep / glob | Yes                                      | Yes                                         |
| Edit / write              | Yes (fuzzy edit)                         | Yes (str_replace, write_file)               |
| Apply patch               | Yes                                      | Yes                                         |
| Shell                     | `bash` (multi shell kinds)               | `run_command` / sandbox allowlist           |
| Background                | Background jobs + experimental subagents | backgroundShell + await_command             |
| Todo                      | todowrite                                | todo_write                                  |
| Web                       | webfetch, websearch                      | web_fetch, web_search                       |
| LSP                       | Experimental tool + LSP manager          | First-class chat `lsp` ops                  |
| MCP                       | Client merge into tool resolve           | Outbound tools + inbound inspect MCP server |
| Subagent                  | `task` child session                     | `sub_agent` + worktree mutation             |
| Plan mode                 | plan enter/exit tools (exp)              | hard plan / plan-then-execute               |
| Finish                    | Model finish / StructuredOutput          | Explicit `finish` action + gate             |

### G.6 Editing & snapshots

| Axis           | OpenCode                                 | Babel                                                  |
| -------------- | ---------------------------------------- | ------------------------------------------------------ |
| Snapshot       | Shadow git track/patch/restore/revert    | Checkpoints service + `babel undo`; patch recovery log |
| Revert session | Message/part revert with inverse patches | Branch/rewind cells; undo checkpoints                  |
| Post-edit LSP  | Diagnostics after edit                   | Optional static checks / LSP tool                      |

### G.7 Completion

| Axis           | OpenCode                             | Babel                                          |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| Done when      | Model stop + no open tools           | Model completion **and** honesty gate (policy) |
| Tests          | Agent may run via bash; not enforced | Gate can require authoritative green verifier  |
| False complete | Easy if model claims done            | Harder under strict/required classes           |
| Structured out | StructuredOutput tool                | Schema-heavy deep pipeline; chat finish action |

### G.8 What OpenCode has that Babel lacks (substrate)

1. Production client/server split with generated protocol/SDK
2. SQLite typed message/part store as primary continuity substrate
3. Shadow-git snapshot/revert integrated into session timeline
4. Interactive permission model as first-class evented ask/reply
5. ACP + multi-client surfaces (web/desktop/TUI worker)
6. Plugin system + rich command/agent definitions
7. Provider catalog breadth (models.dev) + AI SDK normalization
8. Full PTY protocol surface for interactive shells

### G.9 What Babel has that OpenCode lacks (reliability)

1. **Authoritative completion honesty** (`isAuthoritativeVerifierCommand`, reject ad-hoc/inline probes)
2. Task-class verification policies (`none|required|strict`)
3. Diff critic second-opinion path
4. Windows fatal verifier exit thrash control
5. Workspace dep preflight / ENV_BLOCKED-style honesty
6. Governed multi-stage deep pipeline with evidence contracts
7. Dense unit tests specifically around gates, stall, sandbox, critic
8. Node-native Windows-first engineering without Bun requirement

---

## H. Same-model request comparison

**Status:** Not captured live. Design for §Y Track B.

| Field to record | OpenCode expected                               | Babel expected                                    |
| --------------- | ----------------------------------------------- | ------------------------------------------------- |
| System stack    | model prompt file + env + AGENTS + MCP + skills | chat stack compile + identity + memory + playbook |
| Tools           | AI SDK tool schemas from registry               | `buildChatToolDefinitions()` JSON tools           |
| History         | `MessageV2.toModelMessagesEffect`               | `buildProviderMessages` dual conversation         |
| Stop            | provider finish / max steps                     | max turns + gate rejection re-prompts             |
| Retry           | session/retry.ts paths                          | runner-level + budget policy                      |

**Experiment:** HTTP recording proxy or mock provider; hold model id, temperature, max tokens; dump both request bodies side-by-side. Mark `[RUNTIME-VERIFIED]` only after capture.

---

## I. Editing and workspace analysis

| Scenario               | OpenCode                                         | Babel                                     | Babel action                                 |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- | -------------------------------------------- |
| Exact str replace miss | Fuzzy edit path in `edit.ts`                     | Governed str_replace fails cleanly        | Port fuzzy match heuristics selectively      |
| Multi-file patch       | apply_patch + snapshot                           | apply_patch + recovery log                | Add snapshot hash per mutation batch         |
| Crash mid multi-file   | Snapshot restore/revert story                    | Patch recovery log + checkpoints          | Strengthen atomic multi-file settle          |
| Concurrent edit        | File semaphore in edit tool                      | Worktree isolation for mutation subagents | Keep worktrees; add file locks               |
| Non-git repo           | Snapshot still uses git machinery under data dir | Checkpoints FS-based                      | Preserve FS checkpoints; optional shadow git |

---

## J. Environment analysis

| Concern                | OpenCode                          | Babel                              | Opportunity                                                       |
| ---------------------- | --------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| Missing toolchain      | Agent discovers via bash          | Dep preflight + doctor             | **Babel lead — keep**                                             |
| Test command discovery | Agent + bash                      | `projectTestDiscovery`             | Surface in gate UX always                                         |
| Docker isolation       | Not default harness               | Benchmark container profile        | Optional OS sandbox sidecar (Codex-like), not required for parity |
| Windows shells         | bash/pwsh/cmd kinds in shell tool | ComSpec + cmd allowlist + NTSTATUS | Preserve Babel Windows edge                                       |

**Readiness planner (surpass):** run discovery/preflight **before** expensive model turns; attach receipt to session.

---

## K. Verification analysis

| Kind                 | OpenCode             | Babel                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------- |
| Ordinary completion  | Model stops          | Model completion action                                           |
| Verified acceptance  | Not first-class      | Gate + receipts + critic                                          |
| Independent verifier | No                   | Diff critic optional; not fully isolated process                  |
| Tamper resistance    | Agent can edit tests | Verifier integrity / cache invalidation ideas in ChatEngine R8/R9 |

**Conclusion:** For same-model **verified** work, Babel’s policy layer is the stronger product theory. For **raw coding throughput**, OpenCode’s lack of gate may look “faster” while increasing false-complete risk.

---

## L. Persistence and recovery analysis

| Restart boundary          | OpenCode survives?                          | Babel survives?                                    |
| ------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Context compaction        | Yes (compaction parts + filter)             | Yes (summary message)                              |
| Client disconnect         | Server/session continues (TUI worker model) | In-process: session dies with client unless daemon |
| Session resume            | SQLite load                                 | thread event log / transcript resume               |
| Runtime restart           | DB + snapshots                              | Disk sessions; mid-tool may be incomplete          |
| Tool cancellation         | Interrupted tool marked; orphans handled    | Abort + background job cleanup                     |
| Process kill mid mutation | Snapshot restore path                       | Checkpoints + recovery log (weaker atomicity)      |
| Daemon crash              | N/A (server process model)                  | `daemon/recovery` requeues abandoned jobs          |

**Babel gap:** client/server separation + durable tool settlement before side effects (OpenCode V2 explicitly records tool call then settles).

---

## M. Permissions and security audit

| Control         | OpenCode                                           | Babel                                       |
| --------------- | -------------------------------------------------- | ------------------------------------------- |
| Path fence      | Instance directory + external_directory permission | projectRoot resolve fence                   |
| Shell injection | Tool/shell implementation + permissions            | Operator char block, shell:false, allowlist |
| Secrets files   | ask on `*.env` defaults                            | Public scrub + sandbox; not identical       |
| Permission UX   | Evented ask/allow/deny with save                   | Approval profiles + JIT approve             |
| Plugin trust    | Plugin loader + config                             | `services/plugins.ts` trust levels          |
| OS sandbox      | Not default                                        | Docker optional                             |

**Reproducible tests to add (both product gaps):**

1. Write outside project root → deny
2. `rm -rf /` style shell → deny
3. Malicious AGENTS.md role-override → tool policy still holds
4. Package postinstall during agent shell → require approval
5. Mid-tool kill → no half-written secret leak / partial multi-file without receipt

---

## N. Server / protocol / SDK analysis

| Item                            | OpenCode                                      | Babel                                                                                                                                            |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire protocol                   | HTTP API + Event bridge + V2 protocol package | JSON-RPC sketch ADR-010                                                                                                                          |
| SDK                             | packages/sdk, sdk-next, client                | protocol/client partial                                                                                                                          |
| OpenAPI                         | Present in product surface                    | Not productized for agent                                                                                                                        |
| ACP                             | First-class `acp` command + package           | Absent                                                                                                                                           |
| Minimal Babel protocol proposal | —                                             | Extend ADR-010 to production: keep NDJSON JSON-RPC; add `session.event`, `permission.ask/reply`, `pty.*`, `fs.snapshot`, mirror ChatEvent stream |

### N.1 Minimal proposed Babel protocol (implementation-ready)

| Method                                                                                 | Purpose                    |
| -------------------------------------------------------------------------------------- | -------------------------- |
| `thread.create` / `resume`                                                             | Existing ADR-010           |
| `turn.submit` / `cancel`                                                               | Existing                   |
| `permission.respond`                                                                   | Allow/deny/always for tool |
| `history.lookup`                                                                       | Existing                   |
| Notifications: `turn.event`, `permission.request`, `snapshot.updated`, `gate.rejected` | Trust-first UX             |

Do **not** invent a second protocol; **implement** ADR-010 D2/D3 with OpenCode-inspired event richness.

---

## O. Client analysis

| Client     | OpenCode                    | Babel                            |
| ---------- | --------------------------- | -------------------------------- |
| TUI        | OpenTUI Solid worker client | Custom ANSI BabelRepl in-process |
| Web        | packages/app, web           | Absent product                   |
| Desktop    | packages/desktop            | Absent                           |
| ACP / IDE  | acp + vscode sdk            | bridge experimental              |
| Automation | run/serve/SDK               | chat-headless + scripts          |
| Slack      | packages/slack              | Absent                           |

**Parity priority:** server + thin TUI client before web/desktop.

---

## P. Agents and extensibility

| Feature                 | OpenCode                                     | Babel                                   |
| ----------------------- | -------------------------------------------- | --------------------------------------- |
| Multi-agent definitions | Agent service + prompts                      | Subagents + deep roles                  |
| Commands                | Config commands + templates                  | slash / workflow commands               |
| Skills                  | skill tool + discovery                       | skillForge + catalog skills             |
| Plugins                 | First-class plugin package                   | plugins.ts hooks                        |
| MCP                     | Client + catalog                             | Client tools + control-plane MCP server |
| Hooks                   | Plugin triggers (tool before/after, command) | runtime/hooks + plugins                 |

---

## Q. Capability matrix

Legend: **HAS** / **PARTIAL** / **ABSENT** / **UNVERIFIED**

| Capability               | OpenCode        | Babel          | Evidence                               |
| ------------------------ | --------------- | -------------- | -------------------------------------- |
| Interactive coding TUI   | HAS             | HAS            | opentui / BabelRepl                    |
| Headless run             | HAS             | HAS            | run / chat-headless                    |
| Native tool calling      | HAS             | PARTIAL        | AI SDK vs runner-dependent             |
| Text tool fallback       | UNVERIFIED/low  | HAS            | textToolParser                         |
| File read/search         | HAS             | HAS            | tools                                  |
| Edit / write / patch     | HAS             | HAS            |                                        |
| Fuzzy edit               | HAS             | PARTIAL        | OpenCode edit.ts; Babel exact match    |
| Shadow snapshot/revert   | HAS             | PARTIAL        | checkpoints/undo ≠ full session revert |
| Shell                    | HAS             | HAS            | allowlist on Babel                     |
| PTY interactive          | HAS             | ABSENT/PARTIAL | core pty vs background only            |
| Background processes     | HAS             | HAS            |                                        |
| LSP                      | PARTIAL (exp)   | HAS            | Babel chat lsp ops                     |
| MCP client               | HAS             | HAS            |                                        |
| MCP agent host           | PARTIAL         | PARTIAL        | different surfaces                     |
| Skills                   | HAS             | HAS            |                                        |
| Plugins                  | HAS             | PARTIAL        |                                        |
| AGENTS.md load           | HAS             | HAS            |                                        |
| Subagents                | HAS             | HAS            | child session vs nested engine         |
| Worktree isolation       | HAS (workspace) | HAS            | implementWorktreeAgent                 |
| Completion honesty gate  | ABSENT          | HAS            | completionGatePolicy                   |
| Diff critic              | ABSENT          | HAS            |                                        |
| ENV readiness honesty    | PARTIAL         | HAS            | preflight                              |
| SQLite session DB        | HAS             | PARTIAL        | Babel uses files/SQLite meta elsewhere |
| Client/server agent      | HAS             | PARTIAL        | protocol sketch + bridge               |
| ACP                      | HAS             | ABSENT         |                                        |
| Desktop/web              | HAS             | ABSENT         |                                        |
| Multi-provider catalog   | HAS             | PARTIAL        | many runners; chat narrow typing       |
| Windows-first            | PARTIAL         | HAS            |                                        |
| OS sandbox default       | ABSENT          | PARTIAL        | Docker optional                        |
| Daemon queue             | PARTIAL         | HAS            | Babel daemon                           |
| Same-model bench harness | PARTIAL         | PARTIAL        | both have tests/scripts                |

---

## R. Failure-mode matrix

| Failure                     | OpenCode behavior            | Babel behavior          | Prefer for reliability             |
| --------------------------- | ---------------------------- | ----------------------- | ---------------------------------- |
| Model claims done, no tests | Accepts if finish            | Gate may reject         | **Babel**                          |
| Ad-hoc `_verify.py` green   | Accepts                      | Not authoritative       | **Babel**                          |
| Provider mid-stream drop    | Retry / error parts          | Runner errors + resume  | OpenCode edge on durable parts     |
| Tool cancel                 | Interrupted marker           | Abort                   | OpenCode cleaner parts model       |
| Context overflow            | Auto compaction              | Compaction manager      | Tie / OpenCode more structured     |
| Edit miss                   | Fuzzy                        | Fail observation        | OpenCode throughput; Babel honesty |
| Shell missing binary        | Tool error text              | Preflight may ENV_BLOCK | **Babel** honesty                  |
| Client crash                | Server may continue          | Session stops           | **OpenCode**                       |
| Process kill mid multi-edit | Snapshot revert              | Recovery log            | **OpenCode**                       |
| Malicious AGENTS.md         | Still subject to permissions | Policy + sandbox        | Tie if both enforce                |
| Windows python crash loop   | Generic retry risk           | Fail-fast NTSTATUS      | **Babel**                          |
| Dual-path wrong engine      | V1/V2 confusion              | Chat vs deep confusion  | Both debt                          |

---

## S. Weighted assessments

Weights reflect **same-model coding-task completion reliability**, not popularity.

| Scenario                            | Weight | OpenCode             | Babel | Winner   |
| ----------------------------------- | ------ | -------------------- | ----- | -------- |
| Small bug fix, no test ask          | 0.15   | 0.85                 | 0.75  | OpenCode |
| Multi-file feature + tests required | 0.20   | 0.70                 | 0.82  | Babel    |
| Long session resume after restart   | 0.12   | 0.88                 | 0.70  | OpenCode |
| Provider switch same model family   | 0.10   | 0.85                 | 0.72  | OpenCode |
| Windows repo tooling                | 0.10   | 0.65                 | 0.88  | Babel    |
| False-complete resistance           | 0.15   | 0.55                 | 0.90  | Babel    |
| Client disconnect / remote TUI      | 0.08   | 0.90                 | 0.40  | OpenCode |
| Solo-maintainer operability         | 0.10   | 0.55 (huge monorepo) | 0.70  | Babel    |

**Composite (rough):** OpenCode ~0.75, Babel ~0.75 — **split leadership**. Scores are `[INFERRED]` from architecture, not live pass rates. Do not treat as benchmark results.

**Confidence:** High on architecture; **low** on absolute pass-rate numbers until §Y runs.

---

## T. Copy / adapt / reject / preserve / defer

| OpenCode component            | Decision                    | Feasibility (TS port)      | Notes                                                  |
| ----------------------------- | --------------------------- | -------------------------- | ------------------------------------------------------ |
| SessionPrompt loop structure  | **Adapt**                   | High concept / Medium code | Effect-heavy; reimplement in Node idioms               |
| Message/part schema           | **Adapt**                   | High                       | Evolve thread event log toward typed parts             |
| SQLite session store          | **Adapt**                   | Medium                     | Or strengthen existing thread store first              |
| Snapshot shadow git           | **Port concept**            | Medium                     | Integrate with checkpoints                             |
| Session revert                | **Adapt**                   | Medium                     |                                                        |
| Permission ask/reply events   | **Adapt**                   | High                       | Wire into TUI + protocol                               |
| AI SDK provider layer         | **Defer / selective**       | Medium                     | Babel already multi-runner; don’t double stack blindly |
| models.dev catalog            | **Adapt lightly**           | High                       | Optional catalog feed                                  |
| Plugin system                 | **Adapt**                   | Medium                     | Align with plugins.ts                                  |
| ACP                           | **Defer** after protocol D2 | Medium                     |                                                        |
| OpenTUI rewrite               | **Reject** (near-term)      | Low ROI                    | Keep Babel TUI; thin-client later                      |
| V2 SessionRunner Effect stack | **Reject direct port**      | Low                        | Learn durable settle; don’t import Effect monorepo     |
| Bun runtime                   | **Reject as requirement**   | N/A                        | Stay Node; dual-shim ideas optional                    |
| Hosted share/console          | **Reject** for core         | N/A                        |                                                        |
| Doom loop permission          | **Adapt**                   | High                       |                                                        |
| Fuzzy edit                    | **Adapt**                   | High                       |                                                        |
| StructuredOutput tool         | **Adapt**                   | Medium                     | For headless contracts                                 |
| Completion-without-gate       | **Reject**                  | —                          | Keep Babel gate                                        |
| Dual V1/V2 product debt       | **Reject**                  | —                          | Do not copy dual-runtime mess; migrate once            |

**Existing Babel to retain:** completionGatePolicy, verifierFailFast, projectTestDiscovery, workspaceDepPreflight, chatStackCompile, governedMutations, worktree mutation agents, Windows sandbox, evidence/deep pipeline, dense gate tests.

**Technical debt to remove:** dual mental models without router honesty; package version conflict (`0.1.0` vs `1.0.0`); dead lite bin surface; ChatEngine mega-module pressure (continue extraction).

---

## U. Migration architecture

### Direction comparison

| Direction                       | Summary                                                   | Verdict                                                        |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **A** OpenCode-like foundation  | Rebuild Babel as general OpenCode clone + later add gates | Too costly; jettisons unique honesty early                     |
| **B** Distinct governed runtime | Keep only Babel architecture                              | Leaves substrate gaps (server, durability, product UX) unfixed |
| **C** Layered                   | OpenCode-like substrate under Babel governance            | **Best long-term shape**                                       |
| **D** Selective convergence     | Port specific components only                             | **Best near-term execution**                                   |

**Selected strategy: C implemented via D waves** (layered destination, selective port sequence).

### Why not pure A

OpenCode V1 is Effect-service heavy and Bun-first; V2 incomplete. A rewrite throws away Babel’s tested honesty layer and Windows path.

### Why not pure B

Without substrate parity, same-model everyday completion and multi-client recovery remain structurally behind regardless of gates.

### Migration shape

```
Wave 0  Stabilize single everyday path honesty (ChatEngine-only product story)
Wave 1  Durable tool lifecycle + typed parts/event schema
Wave 2  Snapshot/revert + multi-file atomicity
Wave 3  App-server protocol D2 (thin TUI client optional)
Wave 4  Permission event UX + doom-loop + external_directory parity
Wave 5  Provider capability matrix + request capture harness
Wave 6  Surpass: acceptance compiler + evidence graph + independent verifier
```

**Shadow-execution strategy:** run OpenCode-like snapshot + permission modules behind flags; compare receipts on same tasks.
**Rollback:** feature flags per wave; session format dual-read.
**Compatibility:** keep transcript resume forever until parts store proven.

### Licensing

Both MIT → porting concepts/code with attribution is feasible. Still prefer reimplementation over large verbatim copies to avoid Effect/Bun entanglement.

---

## V. P0–P3 roadmap

### P0 — Parity foundations (blocking everyday trust)

1. Durable tool call record **before** side effects (OpenCode V2 settle pattern)
2. Typed session events/parts dual-written with transcript
3. Multi-file mutation batch + checkpoint hash
4. Gate remains on by default for execute task classes

### P1 — Practical parity

5. Shadow-git or enhanced snapshot restore/revert
6. Permission ask/reply protocol + TUI prompts
7. Fuzzy str_replace
8. App-server D2 for headless/TUI split
9. Doom-loop detector parity

### P2 — Product maturity

10. ACP or IDE bridge productization
11. Plugin API hardening
12. Provider capability matrix tests
13. PTY optional surface

### P3 — Surpass

14. Acceptance-contract compiler
15. Evidence graph + revision-bound receipts
16. Independent verifier process (no write to code under test)
17. Adaptive progress controller (evidence deltas)
18. Environment readiness planner pre-turn

---

## W. Fastest-path backlog (first 18 GitHub issues)

Issues are dependency-ordered. Copy into GitHub as needed.

### Issue 1 — Durable tool settlement before side effects

- **Problem:** Mid-tool crash loses call/result pairing and mutates without receipt.
- **Scope:** ChatEngine/toolExecutor: insert pending tool record → execute → complete/error atomically on disk.
- **Non-goals:** Full SQLite migration.
- **Design:** Extend thread event log with `tool.pending|running|completed|error`.
- **Acceptance:** Kill process mid-shell; resume shows interrupted tool, no silent success.
- **Tests:** Fault-injection unit + resume test.
- **Deps:** none. **Risk:** medium.
- **Files:** `threadEventLog.ts`, `toolExecutor.ts`, `chatEngine.ts`.
- **OpenCode ref:** `packages/core/src/session/runner/llm.ts` durable settle comments + tool registry settle.

### Issue 2 — Typed parts schema (additive)

- **Problem:** Transcript alone is weak for reasoning/tool/snapshot continuity.
- **Scope:** Zod schemas for part types; dual-write.
- **Acceptance:** Resume reconstructs tool IDs 100% on fixture corpus.
- **Deps:** #1. **Files:** `services/threadStore/*`, `agent/contracts.ts`.
- **OpenCode ref:** `SessionV1` parts in schema package.

### Issue 3 — Snapshot track per mutation batch

- **Problem:** No reliable revert of agent file set.
- **Scope:** Integrate checkpoints with batch hash; CLI `babel undo --last-agent-batch`.
- **Acceptance:** Apply 3-file edit; undo restores digests.
- **Deps:** #1. **Files:** `services/checkpoints.ts`, mutation tools.
- **OpenCode ref:** `packages/opencode/src/snapshot/index.ts`.

### Issue 4 — Session revert to message boundary

- **Problem:** Users cannot rewind agent timeline cleanly.
- **Scope:** Revert API using snapshots + inverse patches.
- **Deps:** #2,#3. **OpenCode ref:** `session/revert.ts`.

### Issue 5 — Permission ask/reply events

- **Problem:** Approvals exist but not as durable evented protocol.
- **Scope:** Emit permission.request; block tool until reply; save rules.
- **Deps:** #2. **OpenCode ref:** `permission/*`, core PermissionV2.

### Issue 6 — Doom-loop detector

- **Problem:** Identical failing tools thrash.
- **Scope:** 3× identical call → force ask or stop with explanation.
- **Deps:** #5 optional. **OpenCode ref:** processor doom_loop.

### Issue 7 — Fuzzy str_replace

- **Problem:** Exact match fails waste turns.
- **Scope:** Line-ending + whitespace fuzzy; never silent wrong match.
- **Tests:** Golden fixtures. **OpenCode ref:** `tool/edit.ts`.

### Issue 8 — App-server D2 implement ADR-010

- **Problem:** TUI embeds engine; no multi-client recovery.
- **Scope:** stdio JSON-RPC server hosting ChatEngine; optional client mode.
- **Deps:** #1,#2. **Files:** `protocol/*`, `interactive/*`.
- **OpenCode ref:** server routes + TUI worker.

### Issue 9 — Gate rejection as first-class event

- **Problem:** Gate rejects are under-exposed in UI/protocol.
- **Scope:** `gate.rejected` event with reason codes; trust panel.
- **Deps:** #8 for protocol; can land in TUI first.

### Issue 10 — Same-model request recorder

- **Problem:** Harness and provider effects are not yet isolated by a shared capture fixture.
- **Scope:** Mock/proxy dump of system/tools/messages for chat path.
- **Deps:** none. **Files:** runners + test harness.

### Issue 11 — OpenCode vs Babel fixture corpus

- **Problem:** No shared tasks for parity.
- **Scope:** 12 tasks from §Y.6 mini set; containerized.
- **Deps:** #10.

### Issue 12 — Environment readiness planner pre-turn

- **Problem:** Expensive turns die on missing deps.
- **Scope:** Preflight receipt attached before first LLM call.
- **Deps:** workspaceDepPreflight. **Preserve Babel lead.**

### Issue 13 — Authoritative verifier receipt digests

- **Problem:** Receipts lack revision-bound integrity.
- **Scope:** workspace rev + file digests + cmd + exit + output digest.
- **Deps:** #1. Surpass item.

### Issue 14 — Independent verifier process

- **Problem:** Agent can edit tests then green.
- **Scope:** Verifier subprocess read-only FS view or clean worktree.
- **Deps:** #3,#13.

### Issue 15 — external_directory permission parity

- **Problem:** Path fence is hard deny without user escalation path.
- **Scope:** Ask to leave project root with audit.
- **Deps:** #5. **OpenCode ref:** external-directory.ts.

### Issue 16 — Provider capability matrix CI

- **Problem:** Uneven chat runner support.
- **Scope:** Table of tools/stream/reasoning per runner; CI mock.
- **Deps:** #10.

### Issue 17 — Thin TUI client mode

- **Problem:** In-process coupling.
- **Scope:** Flag `BABEL_TUI_CLIENT=1` talking to app-server.
- **Deps:** #8. **Reject** OpenTUI rewrite.

### Issue 18 — Version string conflict fix

- **Problem:** package 0.1.0 vs CLI 1.0.0 `[CONFLICT]`.
- **Scope:** Single source of truth. **Deps:** none. Hygiene.

_(Expand to 25 with: PTY defer issue, ACP defer, plugin API, StructuredOutput tool, background job durability, malicious AGENTS tests, Windows shell matrix, share-not-to-build, migration dual-read removal date.)_

---

## X. Surpass architecture

### X.1 Acceptance-contract compiler

Convert user request → required behavior, regression constraints, non-goals, required evidence, env assumptions, ambiguity list.
**Foundation:** lite contract / intentCompiler / deep orchestrator contracts.
**OpenCode equivalent:** none first-class.
**Same-model effect:** fewer wrong-scope patches.

### X.2 Evidence graph

Link claims → source/search/patch/static/test/runtime/reviewer/verifier/env nodes.
**Foundation:** runEvidence, progress receipts, tool logs.
**Effort:** high. **Defensibility:** high.

### X.3 Revision-bound receipts

Every verifier receipt: workspace rev, digests, cwd, env digest, exit, output digest, invalidation rules.
**Foundation:** lastVerifierReceipt + integrity hooks.

### X.4 Environment readiness planner

Pre-turn preflight; block or replan if toolchain missing.
**Foundation:** workspaceDepPreflight, doctor, projectTestDiscovery.

### X.5 Adaptive progress controller

Stop/replan based on evidence deltas not fixed action counts.
**Foundation:** stallDetector, implementor scorecard, budget kill.

### X.6 Independent verifier

Clean process cannot mutate implementation or tests.
**OpenCode:** absent. **Defensibility:** core differentiator.

### X.7 Durable multi-agent scheduler

Scout / implementor / reviewer / verifier / merger with worktree ownership.
**Foundation:** agentRunCoordinator, worktree agents, deep stages.
**OpenCode:** task child sessions + background jobs.

### X.8 Trust-first client

Expose acceptance claims, missing evidence, revision, diff, receipts, why-stopped, safe resume.
**Requires:** protocol D2 + UI panels.

---

## Y. Controlled OpenCode-versus-Babel benchmark

### Y.1 Tracks

| Track                | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| A Exact same-model   | Same provider/model/params/repo/task/env/budget |
| B Request-normalized | Proxy dump compare prompts/tools/history        |
| C Tool-normalized    | Equal tool surface subset                       |
| D Native-product     | Each product default config (practical quality) |

### Y.2 Controls

Clean git commit, container image, CPU/RAM, network policy, cache cold/hot labeled, no human mid-task, fixed retry budget.

### Y.3 Mini task set (run first)

1. Small bug + unit test
2. Multi-file feature
3. Type error fix
4. Missing executable / ENV
5. Resume after kill mid-tool
6. False-complete temptation (no tests)
7. Ad-hoc verify temptation
8. Patch conflict
9. Windows path task
10. Malicious AGENTS.md injection

### Y.4 Metrics (minimum)

Task pass, verified pass, false-complete, empty-patch, recovery success, resume correctness, tokens/cost/wall, gate reject accuracy, human interventions.

### Y.5 Fault injection

Kill before model, mid-stream, mid-tool, after mutation before persist, during compact, client disconnect.

### Y.6 Trajectory classes

Model / provider / context / tool schema / edit / shell / env / policy / verification / persistence / protocol.

**Status this report:** design only — **not executed**.

---

## Z. Architecture decision records (five)

### ADR-OC-1: Layered selective convergence (Direction C via D)

- **Context:** Split leadership OpenCode substrate vs Babel honesty.
- **Decision:** Converge substrate; preserve gates as differentiator.
- **Alternatives:** Full OpenCode clone; pure isolation; full Effect/Bun rewrite.
- **Consequences:** Multi-wave migration; temporary dual formats.
- **Migration:** Waves 0–6 §U.
- **Rollback:** Feature flags; transcript dual-read.
- **Validation:** §Y tracks A/B after Waves 1–2.

### ADR-OC-2: Single everyday runtime = ChatEngine

- **Context:** Chat vs deep dual engines confuse operators and tests.
- **Decision:** Product default remains ChatEngine; deep is opt-in rigor.
- **Alternatives:** Merge deep into chat only; make deep default.
- **Consequences:** Invest substrate in chat path first.
- **Validation:** Docs + CLI help + metrics on mode share.

### ADR-OC-3: Node remains product runtime (reject Bun requirement)

- **Context:** OpenCode Bun-first; Babel Node ≥22.5.
- **Decision:** Stay Node; optional ideas from OpenCode Node shims only.
- **Alternatives:** Adopt Bun; dual runtime.
- **Consequences:** No direct Bun API ports.
- **Validation:** CI Windows+Linux Node only.

### ADR-OC-4: App-server before web/desktop

- **Context:** OpenCode multi-client; Babel ADR-010 sketch.
- **Decision:** Implement protocol D2; thin TUI client; defer web/desktop.
- **Alternatives:** Keep in-process forever; build web first.
- **Validation:** Headless client + kill/resume tests.

### ADR-OC-5: Keep completion honesty; never port OpenCode stop semantics

- **Context:** OpenCode stops on model finish; Babel gates false completes.
- **Decision:** Gates remain for execute task classes; improve UX of rejects.
- **Alternatives:** Optional gate-off for “speed mode” only with hard labeling.
- **Validation:** False-complete rate on §Y tasks; regression tests on ad-hoc verify.

---

## AA. Final recommendation table

| Priority | Change                        | Parity / surpass | Same-model impact      | Effort | Dependency | Migration  | Acceptance gate                  |
| -------- | ----------------------------- | ---------------- | ---------------------- | ------ | ---------- | ---------- | -------------------------------- |
| P0       | Durable tool settlement       | Parity           | High recovery          | M      | —          | D          | Kill mid-tool resume             |
| P0       | Typed parts dual-write        | Parity           | High continuity        | M      | settlement | D          | Resume tool ID fidelity          |
| P0       | Mutation batch snapshots      | Parity           | High edit safety       | M      | settlement | D          | Undo restores digests            |
| P1       | Permission events             | Parity           | Medium safety UX       | M      | parts      | D          | Ask blocks tool                  |
| P1       | Fuzzy edit                    | Parity           | Medium throughput      | S      | —          | D          | Golden fixtures                  |
| P1       | App-server D2                 | Parity           | High multi-client      | L      | parts      | C/D        | Client kill ≠ agent kill         |
| P1       | Doom-loop                     | Parity           | Medium cost            | S      | —          | D          | 3× identical tool stops          |
| P2       | Provider matrix CI            | Parity           | High portability truth | M      | recorder   | D          | Matrix green                     |
| P2       | Independent verifier          | Surpass          | High verified pass     | L      | snapshots  | C          | Verifier cannot write tree       |
| P2       | Revision-bound receipts       | Surpass          | High trust             | M      | settlement | C          | Receipt invalidation tests       |
| P3       | Acceptance compiler           | Surpass          | High scope control     | L      | contracts  | C          | Ambiguity surfaces before mutate |
| P3       | Evidence graph UI             | Surpass          | High trust UX          | L      | protocol   | C          | Claims linked to receipts        |
| —        | OpenTUI rewrite               | —                | Low                    | XL     | —          | **Reject** | —                                |
| —        | Bun product runtime           | —                | Low                    | XL     | —          | **Reject** | —                                |
| —        | Drop completion gate          | —                | Negative               | S      | —          | **Reject** | —                                |
| —        | Full OpenCode monorepo import | —                | Negative complexity    | XL     | —          | **Reject** | —                                |

---

## AB. Strategic conclusion

**Should Babel become an OpenCode-like provider-neutral coding-agent platform with stronger verification, or preserve a materially different execution architecture?**

**Answer:** Become **OpenCode-like in execution substrate and multi-client product shape**, while **preserving a materially different verification/governance layer**. That is **Direction C**, delivered through **Direction D** selective waves—not a rewrite, not isolationism.

### Why (evidence-backed)

1. **OpenCode’s real advantage** is a productized general agent runtime: durable sessions, tools, server/TUI split, snapshots, providers, extensibility — visible in `SessionPrompt.runLoop`, SQLite parts, snapshot service, HTTP API, and package topology.
2. **Babel’s real advantage** is **honest completion and Windows/environment realism** — visible in `completionGatePolicy`, `verifierFailFast`, preflight, and dense gate tests.
3. **Same-model leadership is split.** Everyday raw coding and recovery favor OpenCode; verified acceptance favors Babel. Ignoring either side is strategy by brand.
4. **Migration cost favors reimplementation of concepts in Node/TS** over importing OpenCode’s Effect/Bun monorepo or rewriting Babel.
5. **Surpass path is clear:** OpenCode has no acceptance-contract compiler, evidence graph, or independent verifier. Those are defensible differentiators **only if** the substrate is good enough that the model can actually finish tasks.

### What not to build

- OpenCode Console/share clone
- Bun as required runtime
- OpenTUI rewrite as near-term
- Second incomplete agent runtime (do not copy V1/V2 dual-life)
- Gate-free “just like OpenCode” mode as default

### Highest-value next move

Implement **Issue #1 (durable tool settlement)** + **Issue #10 (request recorder)** in the same week: one improves real recovery, the other enables proof of same-model harness effects.

---

## Appendix A — Evidence index (primary)

### OpenCode (local `bce2992` unless noted)

- `packages/opencode/src/session/prompt.ts` — `runLoop` exit conditions
- `packages/opencode/src/session/processor.ts` — compact|stop|continue
- `packages/opencode/src/session/instruction.ts` — AGENTS.md / CLAUDE.md
- `packages/opencode/src/session/compaction.ts` — prune constants
- `packages/opencode/src/snapshot/index.ts` — shadow git snapshots
- `packages/core/src/session/runner/llm.ts` — V2 durable runner checklist
- `packages/core/src/tool/builtins.ts` — V2 built-in tools
- `packages/core/src/permission.ts` — permission V2
- Root `package.json` — Bun workspace, packageManager
- GitHub API — default branch `dev`, release `v1.18.11`, tip `32f278b`
- Archived `opencode-ai/opencode`

### Babel (`63c3942`)

- `babel-cli/src/agent/chatEngine.ts` — primary loop
- `babel-cli/src/agent/chatToolDefinitions.ts` — tools
- `babel-cli/src/agent/completionGatePolicy.ts` — honesty
- `babel-cli/src/agent/chatCompaction.ts` — compaction
- `babel-cli/src/sandbox.ts` — SafeExecutor
- `babel-cli/src/protocol/types.ts` + ADR-010 — sketch protocol
- `babel-cli/src/daemon/recovery.ts` — crash recovery
- `babel-cli/src/interactive/chatSessionResume.ts` — resume
- `babel-cli/package.json` — version 0.1.0, Node engines

### Explicitly not used for scoring

- GitHub star counts
- OpenCode Zen pricing
- Babel Prompt OS layer catalog
- Historical archived OpenCode as current peer

---

## Appendix B — Research process notes

1. Read full deep-research prompt from user `.docx`.
2. Resolved active OpenCode repo via GitHub metadata (default branch **`dev`**).
3. Confirmed historical `opencode-ai/opencode` archived.
4. Mapped local OpenCode monorepo + Babel `babel-cli` with parallel explore agents + direct file reads.
5. Cross-checked against prior Babel vs Codex report methodology for deliverable shape.
6. **Did not** run full same-model live campaign or fault injection — marked throughout.

---

_End of report. A Babel maintainer should be able to open Wave 0 issues from §W without re-discovering architecture._
