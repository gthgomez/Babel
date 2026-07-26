<!-- License: MIT — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-07-24
role: CANONICAL_FOUR_WAY_HARNESS_TEARDOWN
purpose: Evidence-backed Babel-home teardown vs Codex / Grok Build / OpenCode — harness internals, CLI/TUI surfaces, gaps, catch-up plan, and test contracts for the next implementation waves
-->

# Babel vs Codex · Grok Build · OpenCode — Harness Teardown & Implementation Plan

**Date:** 2026-07-24  
**Status:** **ACTIVE** — planning reference for the next Babel usability / catch-up waves  
**Home product:** `./babel-cli`  
**Competitor clones (shallow tips used for this audit):**

| Product | Repo | Tip | Local path |
|---------|------|-----|------------|
| Codex | `openai/codex` | `[commit-hash]` (2026-07-24) | `/workspace-root/TUI-CLI-Examples/_compare/openai-codex` |
| Grok Build | `xai-org/grok-build` | `[commit-hash]` (2026-07-23) | `/workspace-root/TUI-CLI-Examples/_compare/grok-build` |
| OpenCode | `anomalyco/opencode` | `[commit-hash]` on `dev` (2026-07-24) | `/workspace-root/TUI-CLI-Examples/_compare/opencode` |

**Canvas companion:** `~/.config/editor/projects/c-Workspace/canvases/codex-grok-opencode-teardown.canvas.tsx`  
**Stars (GitHub API, 2026-07-24):** Codex ~101k · Grok ~22k · OpenCode ~189k — stars ≠ quality.

---

## How to use this document

| Need | Go to |
|------|-------|
| One-screen verdict | [§1](#1-executive-verdict) |
| Claim discipline / relationship to older plans | [§2](#2-relationship-to-existing-canonical-docs) |
| Verified Babel baseline | [§3](#3-verified-babel-baseline-home-product) |
| **How each harness works (deep)** | [§4](#4-how-each-harness-works) |
| Side-by-side axis matrix | [§5](#5-axis-matrix-babel-relative-verdicts) |
| What Babel lacks (catch-up backlog) | [§6](#6-catch-up-backlog-what-babel-lacks) |
| **Test contracts to compete against** | [§7](#7-test-contracts-compete-against-these) |
| Ordered implementation waves | [§8](#8-implementation-waves) |
| Steal / do-not-steal rules | [§9](#9-steal--do-not-steal) |
| File map | [§10](#10-file-map) |
| Tracking table | [§11](#11-tracking-table) |

### Confidence legend

| Tag | Meaning |
|-----|---------|
| **OBS** | Observed in local source of the named checkout |
| **DOC** | Stated in that project's README/user-guide in the checkout |
| **INF** | Inferred from architecture; verify before implementation |
| **UNVERIFIED** | Not confirmed in this pass (e.g. binary smoke not run) |

---

## 1. Executive verdict

### Product formula (target)

```
OpenCode-class install + BYOM discoverability
  + Grok-class interactive agency (model owns tool sequence; ACP-ready)
  + Codex-class OS sandbox + headless SDK honesty
  + Babel Prompt OS deep governance (on demand)
  + Babel evidence / doctor / undo / claims honesty
```

### One-line verdict

**Babel already has a real coding-agent CLI/TUI and a unique governed `deep` mode — but it is not yet daily-usable against Codex/Grok/OpenCode because reliability, install, BYOM UX, OS sandbox class, ACP/remote embed, and mutating subagents lag.** Catch-up is **make the daily loop trustworthy**, not rebuild the Prompt OS.

### Babel-relative scorecard (2026-07-24)

| Area | Verdict | One-liner |
|------|---------|-----------|
| Skills / plugins / hooks / MCP | **WIN** | Extension surface is at peer parity |
| Plan / deep / chat modes | **WIN** | Typed Prompt OS is unique |
| Evidence / undo / doctor | **WIN** | Stronger trust surface than typical chat CLIs |
| Daily TUI | **MIXED** | Custom fullscreen + mouse exists; discoverability trails OpenCode/Grok |
| Tool loop architecture | **MIXED** | Real ChatEngine tools; protocol fidelity still a known P0 (see Codex parity plan) |
| OS sandbox | **VULNERABLE** | Allowlist + optional Docker ≪ Codex/Grok OS isolation |
| ACP / IDE embed | **VULNERABLE** | Absent; Grok/OpenCode have ACP |
| serve / attach / remote | **VULNERABLE** | Partial bridge; OpenCode is the reference |
| BYOM / providers | **VULNERABLE** | Multi-runner but DeepSeek-centric + fragmented |
| Headless SDK | **VULNERABLE** | CLI JSON only; Codex/OpenCode ship SDKs |
| Mutating subagents | **VULNERABLE** | Read-only Spark; peers ship task workers |
| Install / first-run | **VULNERABLE** | Lab build path vs curl/npm/brew |
| Market reliability | **VULNERABLE** | `claim_ready: false` on parity |

---

## 2. Relationship to existing canonical docs

This teardown **adds the four-way harness + OpenCode** comparison and a usability catch-up sequence. It does **not** replace pairwise deep plans:

| Doc | Role | Use with this file |
|-----|------|--------------------|
| [BABEL_VS_GROK_CLI_UPGRADE_AUDIT_2026-07-16.md](./BABEL_VS_GROK_CLI_UPGRADE_AUDIT_2026-07-16.md) | **CANONICAL** Grok-class agency waves U0–U5 | Keep for agency/UX defaults; this file adds Codex+OpenCode axes |
| [BABEL_CODEX_HARNESS_PARITY_IMPLEMENTATION_PLAN_2026-07-14.md](../plans/BABEL_CODEX_HARNESS_PARITY_IMPLEMENTATION_PLAN_2026-07-14.md) | **CANONICAL** loop-architecture P0–P3 | Keep for protocol fidelity / async executor — still the #1 harness-internal fix |
| babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md | TUI matrix (Codex/Claude/claw) | Still valid for TUI polish; corpus here expands to Grok+OpenCode |
| [docs/status/claims-matrix.md](../status/claims-matrix.md) | Claim discipline | Market parity remains `claim_ready: false` until measured |
| Workspace `AGENTS.md` | Routes Babel as audit/governance by default | Product identity is coding agent — do not confuse workspace routing with product baseline |

**Planning rule:** When this file and the Codex parity plan conflict on loop internals, **Codex parity plan wins**. When this file and the Grok upgrade audit conflict on interactive defaults, **Grok upgrade audit wins**. This file wins on **cross-competitor prioritization** and **OpenCode-derived surfaces** (BYOM, serve/attach, install).

---

## 3. Verified Babel baseline (home product)

### Identity

| Claim source | Statement |
|--------------|-----------|
| `README.md` / `BABEL_BIBLE.md` | Autonomous conversational coding agent + optional governed Prompt OS |
| `babel-cli/package.json` | “Local TypeScript/Node.js runtime harness for the Babel Multi-Agent OS” |
| `docs/status/claims-matrix.md` | Scoped DeepSeek production gate can be GREEN; market parity **not** claim-ready |

**OBS:** Babel is a real agent with first-party tools — not a docs-only compiler for other CLIs. External CLI runners (`codexCli`, `claudeCli`, `geminiCli`) exist as optional backends, not the daily path.

### Entry points

| Invocation | Behavior (**OBS**) |
|------------|-------------------|
| `babel` (no args) | → `interactive` / TUI (`cli/argv.ts` rewrite) |
| `babel "<task>"` | → `run --mode chat` via ChatEngine |
| `babel plan "…"` | Design-first / plan mode |
| `babel deep "…"` | Governed pipeline Orchestrator → SWE → QA → Executor |
| `babel --json` / `--output-format stream-json` | Headless structured output |
| Bins | `babel` active; `babel-lite` / `bl` removed (exit 1 + hint) |

### Capability matrix (home)

| Capability | Mark | Evidence |
|------------|------|----------|
| Interactive coding TUI | **HAS** | `src/interactive/BabelRepl.ts`, `src/ui/*`, alt-screen + mouse in `inputCoordinator.ts` |
| Autonomous file/shell tools | **HAS** | `ChatEngine`, `toolExecutor.ts`, `localTools.ts` |
| OS sandbox | **PARTIAL** | Path jail + command allowlist + optional Docker (`sandbox.ts`, `benchmarkContainer.ts`); no seatbelt/bwrap/landlock in tree |
| ACP | **ABSENT** | No ACP matches under `babel-cli/src` |
| Session resume / fork / undo | **HAS** | `/resume`, `/fork`, `/rewind`, `babel undo`, checkpoints |
| Plan vs build | **HAS** | chat / plan / deep + `enter_plan_mode` tools + `planExecuteMode.ts` |
| MCP client | **HAS** | `tools/mcpTransport.ts`, `babel mcp` |
| MCP server | **HAS (inspection)** | `mcp/server.ts` — catalog/preview, not mutation |
| Skills / plugins / hooks | **HAS** | `02_Skills/`, `services/plugins.ts`, hook events |
| Headless JSON streaming | **HAS** | `--json`, `stream-json` / jsonl / ndjson |
| Multi-model BYOM | **PARTIAL** | Multi-provider runners + `model-policy.json`; DeepSeek-centric defaults |
| Desktop / web | **ABSENT** | `ideBridge.ts` contract stub only |
| Mutating live subagents | **ABSENT / excluded** | Read-only Spark paths; claims-matrix excludes mutating live subagents |

### Baseline axes (competitive-teardown Step 1)

| Axis | Verified local capability | Confidence |
|------|---------------------------|------------|
| Control point | Chat policy + circuit breaker + JIT veto + optional Docker + deep QA gate | high |
| Fail-closed | Network install hard-deny; path jail; headless verifier hard-block | medium |
| Evidence quality | Runs artifacts, cost ledger, doctor, inspect, production benchmark lane | high |
| Enterprise readiness | Plugin trust + enterprise policy; not multi-tenant productized | medium |
| Integration burden | Local `babel.ps1` / npm build; no public one-liner install | high |

---

## 4. How each harness works

This section is the **test-design substrate**. Implementers should be able to map a Babel change to the equivalent competitor control point.

### 4.1 Shared conceptual model

All four products implement roughly:

```text
User input
  → session / thread state
  → model sample (with tools schema)
  → tool calls
  → permission / sandbox gate
  → tool execution
  → observations appended
  → resample until assistant-only (or max turns / abort)
```

They diverge on: **where the TUI sits relative to the loop**, **how messages are represented on the wire**, **what isolates shell**, and **how extensions load**.

---

### 4.2 Codex (`openai/codex`) — protocolized Rust core

**Stack (**OBS**):** Rust monorepo `codex-rs/` + thin npm wrapper `codex-cli/`. TUI = `codex-tui` (ratatui + crossterm). License Apache-2.0. Binary `codex`.

#### Architecture

```text
codex (clap multitool)
  ├─ default → codex-tui  ──protocol──► app-server / core session
  ├─ exec    → headless JSONL ─────────► same turn loop
  ├─ mcp-server / plugin / sandbox / resume / fork / …
  └─ sdk (TS / Python) wrapping exec/app-server

core::session::turn::run_turn
  → pre-sample compact
  → skills/plugins injection
  → hooks
  → sample → ToolRouter → handlers → resample
```

#### Turn loop (**OBS**)

- Owner: `codex-rs/core/src/session/turn.rs` → `run_turn(...)`.
- Contract (from source comments): if the model requests a function call, execute and send output back; if assistant-only message, turn completes.
- Tools routed via `core/src/tools/router.rs` (`ToolRouter`), parallel orchestrator, deferred `tool_search`.
- Model client: Responses API (HTTP + WebSocket) in `core/src/client.rs`; providers include OpenAI + Bedrock + OSS flags (`--oss`, ollama/lmstudio crates).

#### Tools (categories)

| Category | Examples | Notes |
|----------|----------|-------|
| Shell / PTY | `shell_command`, `exec_command`, `write_stdin` | Long-lived PTY session model |
| Patch | `apply_patch` | Freeform Lark grammar |
| Plan | `update_plan` | |
| MCP | MCP calls + resource list/read | Also `codex mcp-server` (Codex as MCP) |
| Multi-agent | `spawn_agent`, `wait_agent`, … | `multi_agent_v1` namespace |
| Meta | `tool_search`, `request_user_input`, `view_image` | Deferred tool loading |

**OBS:** No dedicated model-facing `grep` tool name in handler specs — search is shell + UI file-search + `tool_search`.

#### Permissions / sandbox (**OBS**)

| Layer | Mechanism |
|-------|-----------|
| Sandbox modes | `read-only` / `workspace-write` / `danger-full-access` |
| OS isolation | Linux **bubblewrap** (default), optional legacy Landlock; macOS **Seatbelt**; Windows **restricted token** helpers |
| Approvals | `untrusted` / `on-request` / `never`; TUI `approval_overlay` for exec/patch/MCP |
| Execpolicy | Starlark prefix rules (`codex-rs/execpolicy`) |
| Escape | `--dangerously-bypass-approvals-and-sandbox` / `--yolo` |

#### TUI (**OBS**)

- Fullscreen alt-screen by default; `--no-alt-screen` for inline.
- **Mouse events skipped** (`tui/src/tui/event_stream.rs`).
- History cells, streaming, composer, approval overlay, diff render modules.

#### Headless / embed

- `codex exec` with `--json` JSONL events, `--output-schema`, `--ephemeral`.
- Official `@openai/codex-sdk` (TS) and Python SDK.
- **ACP: not found** in this checkout (**OBS** absence).

#### What to test Babel against (Codex)

1. **Native multi-turn tool protocol** — prior tool calls/results remain structured messages, not flattened Markdown user blobs (see Babel Codex parity plan RC-1).
2. **Cancellable async shell** — TUI stays responsive during long commands.
3. **Sandbox triad** — same task under read-only vs workspace-write vs full-access produces different allow/deny evidence.
4. **JSONL headless** — machine-parseable event stream with final message discipline.
5. **Approval overlay parity** — dangerous ops pause for human when policy = on-request.

---

### 4.3 Grok Build (`xai-org/grok-build`) — ACP-native Rust shell + pager

**Stack (**OBS**):** Rust monorepo mirror from SpaceXAI; Apache-2.0; **no external PRs** (`CONTRIBUTING.md`). Binary artifact `xai-grok-pager`, product name `grok`. Version observed in crates ~`0.2.111`.

#### Architecture

```text
grok  ← xai-grok-pager-bin
  ├─ TUI          xai-grok-pager (ratatui, mouse, fullscreen/minimal)
  ├─ headless     -p / --output-format → in-process ACP client
  └─ agent *      stdio | serve | headless | leader
         │
         ▼
  xai-grok-shell  (ACP session actor)
         │
  xai-grok-tools  (+ implementations/codex + implementations/opencode ports)
  xai-grok-sandbox (nono → Landlock / Seatbelt)
```

#### Turn loop (**OBS**)

- Session actor main loop: `xai-grok-shell/.../run_loop.rs` → `run_session`.
- Sampling: `sampler_turn.rs` → `run_turn_via_sampler`.
- Tool pipeline: prepare → permission → `dispatch_tool` → finalize (parallel prep/dispatch tested in-tree).
- Headless and TUI both speak **ACP** to the shell — the TUI is a client, not the loop owner.

#### Tools (**OBS**)

Primary `grok_build` IDs include: `run_terminal_cmd`, `read_file`, `search_replace`, `list_dir`, `grep`, `todo_write`, `web_search`/`web_fetch`, `task`/`wait_tasks`, plan enter/exit, `lsp`, media tools, scheduler, memory, `use_tool` / `search_tool` (MCP), `skill`.

**Provenance (**OBS** `THIRD-PARTY-NOTICES`):**

| Upstream | Local path | Modules |
|----------|------------|---------|
| `openai/codex` | `xai-grok-tools/.../implementations/codex/` | `apply_patch`, `grep_files`, `list_dir`, `read_file` |
| `sst/opencode` (historical path; product now `anomalyco/opencode`) | `.../implementations/opencode/` | `bash`, `edit`, `glob`, `grep`, `read`, `skill`, `todowrite`, `write` |

This is the clearest “steal legally” map among the three competitors.

#### Permissions / sandbox (**OBS** + **DOC**)

| Layer | Mechanism |
|-------|-----------|
| OS sandbox | `nono` — Landlock (Linux) / Seatbelt (macOS); profiles `off` (default) / `workspace` / `devbox` / `read-only` / `strict` |
| Permission pipeline | PreToolUse hooks → deny/ask/allow rules → remembered grants → auto-approvals → mode |
| Modes | `default`, `dontAsk`, `bypassPermissions`, `acceptEdits`, `plan` |
| Compat | Claude `.claude/settings*.json` + Cursor skill/hook paths |
| Windows FS sandbox | **UNVERIFIED / docs omit** kernel FS sandbox for Windows |

#### TUI (**OBS**)

- Fullscreen + **mouse capture**; `--minimal` scrollback mode; `--no-alt-screen`.
- Dedicated `plan_approval_view`, permission view, question view, extensions/MCP/agents modals.

#### Headless / embed

- `-p` / `--prompt-json` / `--prompt-file` with `plain` | `json` | `streaming-json`.
- `grok agent stdio` for ACP hosts; `serve` / `leader` for multi-client.
- **ACP: first-class** (**OBS**).

#### What to test Babel against (Grok)

1. **ACP round-trip** — external ACP client can init → auth → session → prompt → tool events.
2. **Plan approve UX** — enter plan mode → model proposes → human approve → exit with scoped edits only.
3. **Claude/Cursor import** — drop a `.claude` skill/hook and see it in `inspect` / tool list.
4. **Permission modes** — same prompt under `default` vs `acceptEdits` vs `bypassPermissions` yields different ask counts.
5. **Leader/multi-client** — two clients share one agent backend without forked brain state (**INF** for Babel design).

---

### 4.4 OpenCode (`anomalyco/opencode`) — Bun server/client + OpenTUI

**Stack (**OBS**):** TypeScript/Bun monorepo, MIT, default branch `dev`. Binary `opencode` (npm publish name `opencode-ai`). TUI = SolidJS + **OpenTUI** (`@opentui/solid`). Also in-repo: Electron desktop, Astro web/docs, thin VS Code terminal launcher.

#### Architecture

```text
opencode (yargs)
  ├─ $0 TUI → Worker RPC → @opencode-ai/tui (OpenTUI + Solid)
  ├─ run / serve / attach / web / acp
  └─ desktop (Electron) → packages/app

HTTP Effect server (packages/opencode + core)
  ├─ SQLite sessions
  ├─ ToolRegistry + Permission.ask
  └─ providers via models.dev + @ai-sdk/*
```

#### Turn loop (**OBS**)

- Session/prompt processing under `packages/opencode/src/session/` (message-v2, llm adapters, overflow/compaction).
- Tools from `tool/registry.ts`; each tool execution goes through **Permission** (`allow` | `ask` | `deny`) — not OS sandbox.
- TUI is explicitly a **client** of a local worker or remote `serve`.

#### Tools (**OBS**)

`bash` (compat name), `read`, `write`, `edit`, `glob`, `grep`, `task`, `webfetch`, `websearch`, `todowrite`, `skill`, `apply_patch` (GPT path), experimental `lsp` / `execute` (code-mode), `question`, `plan_exit`.

**DOC/OBS naming trap:** `project.sandboxes` means **git worktrees**, not OS isolation. Core bash tool text states it runs with host user FS/process/network authority.

#### Permissions (**OBS**)

| Agent | Behavior |
|-------|----------|
| `build` | Full access default; allows `question`, `plan_enter` |
| `plan` | Denies most edits; allows plan markdown paths + `plan_exit` |
| `explore` | Mostly deny except search/read/bash/web |

CLI: `--auto` auto-approves non-denied; hidden `--yolo` / `--dangerously-skip-permissions`.

#### TUI (**OBS**)

- Leader key default **`ctrl+x`**; which-key; `Tab` cycles build/plan agents.
- Themes as JSON assets; command palette `ctrl+p`.

#### Headless / embed

- `opencode run --format json`, `serve`, `attach <url>`, `web`, `acp` (stdio NDJSON).
- SDK packages + OpenAPI from HttpApi.
- **ACP: present** as subcommand (**OBS**).

#### What to test Babel against (OpenCode)

1. **serve → attach** — start headless server, attach second TUI/client to same session.
2. **BYOM switch** — `/model` (or equivalent) changes provider mid-session without restart.
3. **Plan vs build Tab** — same task: plan mode cannot write product sources; build can.
4. **Permission doom_loop / external_directory** — ask gates fire on suspicious loops and out-of-root paths.
5. **Install smoke** — one documented install command yields working `opencode --help` on clean machine (**DOC** channels; Babel should match the *shape*).

---

### 4.5 Babel (`babel-cli`) — ChatEngine + optional Prompt OS

**Stack (**OBS**):** Node ≥22.5 TypeScript, Commander CLI, custom TUI (not Ink/OpenTUI/ratatui). ~968 TS files under `src/`, ~200 under `ui/`, ~47 under `interactive/`.

#### Architecture

```text
babel
  ├─ interactive / app  → BabelRepl → ChatEngine (embedded)
  ├─ "<task>" / run     → ChatEngine (same path via chatCore)
  ├─ plan               → plan mode / approval path
  └─ deep               → pipeline.ts (Orchestrator → SWE → QA → Executor)
                              + workflowEngine DAG (partial)

ChatEngine turn:
  sample (native tools stream)
    → tool_calls
    → executeActions → toolExecutor → localTools → SafeExecutor
    → observations
    → phase nudges / stall / circuit breaker / verifiers
    → resample or streamDone
```

#### Turn loop (**OBS**)

- Owner: `src/agent/chatEngine.ts` class `ChatEngine`.
- On `tool_calls`: yield `tool_start` events → `executeActions` → observations → continue.
- Safety overlays: token explosion kill, stall interventions, phase classification nudges (`chatPhaseNudge`), BLOCKED detection, verifier/critic receipts.
- **Known P0 (Codex parity plan):** conversation/tool history can be flattened to Markdown user blobs for DeepSeek native-tools path — this is the primary internal reliability debt vs Codex/Grok native protocol fidelity.

#### Tools (**OBS** chat-facing)

`read_file`, `list_dir`, `grep`, `glob`, `write_file`, `apply_patch`, `str_replace`, `run_command` (+ background), `await_command`, `semantic_search`, `git_context`, `test_run`, `mcp_*`, `todo_write`, `web_search`/`web_fetch`, `lsp`, `sub_agent`, `finish`, plan enter/exit, …

#### Permissions / sandbox (**OBS**)

| Layer | Mechanism |
|-------|-----------|
| Default chat preset | `workspace_write` — mutations often auto-allow |
| Circuit breaker | Consecutive policy blocks → session kill |
| JIT veto | Control-plane writes, anchor escapes, `BABEL_ASK=true` |
| Approval profiles | suggest / auto-edit / full-auto |
| SafeExecutor | Path confinement to project root; command allowlist; `shell: false` spawn |
| Docker | `safe_repo` profile wants Docker when available; `dev_local` sets `dockerSandbox: false` |

**Honest wording:** “No approval prompts” in product copy is **oversimplified** — JIT/permission dialogs exist for gated cases; network installs hard-deny.

#### TUI (**OBS**)

- Custom fullscreen alt-screen + SGR mouse.
- HistoryCell architecture, PromptInput V2, session picker, permission dialogs (post A–E phases).
- Discoverability still weaker than OpenCode leader-key / Grok modal system (**INF** from competitive refs + this teardown).

#### Headless / embed

- `--json`, stream-json/jsonl/ndjson, `chat-headless`, daemon, experimental `goal`.
- Custom `src/protocol/` JSON-RPC sketch — **not ACP**.
- `babel serve` exists in command registration (**OBS**); attach/client maturity **PARTIAL** vs OpenCode.

#### What Babel must validate (self)

1. Multi-file task completes with verifier green — not EARLY_BLOCK_RICH counted as success.
2. REPL model/root/policy refresh across consecutive tasks (no frozen first-turn config).
3. Long `run_command` does not freeze TUI (async executor — Codex parity plan).
4. `babel setup && babel doctor && babel "fix one failing test"` on clean clone.
5. Undo/checkpoint restores after a bad apply_patch.

---

## 5. Axis matrix (Babel-relative verdicts)

| Axis | Babel | Codex | Grok | OpenCode | Babel verdict |
|------|-------|-------|------|----------|---------------|
| Daily coding TUI | Custom TS + mouse | ratatui, no mouse | ratatui + mouse | OpenTUI + leader | **MIXED** |
| Agent tool loop | ChatEngine | `run_turn` + ToolRouter | ACP shell + sampler | Session + Permission | **MIXED** |
| Native tool protocol fidelity | Flattening debt (known) | Structured Responses tools | ACP-native | AI SDK messages | **VULNERABLE** |
| OS sandbox | Allowlist + optional Docker | bwrap/Seatbelt/Win RT | nono Landlock/Seatbelt | Host authority | **VULNERABLE** |
| Approvals UX | JIT + profiles + deep QA | Approval overlay + execpolicy | Modes + plan approve view | allow/ask/deny + Tab agents | **MIXED** |
| ACP | Absent | Absent | First-class | `acp` cmd | **VULNERABLE** |
| serve/attach | Partial | app-server/remote | serve/leader | serve/attach/web | **VULNERABLE** |
| Desktop/web | Absent | Experimental desktop | TUI+voice | Electron+web | **VULNERABLE** |
| BYOM | Partial / DeepSeek-centric | OpenAI+Bedrock+OSS | xAI+custom | models.dev | **VULNERABLE** |
| Headless SDK | CLI JSON only | TS+Python SDKs | streaming-json | SDK+OpenAPI | **VULNERABLE** |
| Skills/plugins/hooks/MCP | HAS | HAS | HAS | HAS | **WIN** |
| Plan/deep modes | chat/plan/deep | update_plan | plan tools+UI | build/plan agents | **WIN** |
| Evidence/undo/doctor | Strong | Moderate | inspect/doctor | session export | **WIN** |
| Mutating subagents | Read-only only | multi_agent_* | task/wait | task/explore | **VULNERABLE** |
| Install/onboarding | Lab path | curl/npm/brew | curl/npm | many channels | **VULNERABLE** |
| Contribution model | Private lab | Public PRs | Mirror, no PRs | Public PRs (dev) | n/a |

---

## 6. Catch-up backlog (what Babel lacks)

Ordered for **daily usable**, not feature vanity.

### P0 — Usability blockers

| ID | Gap | Steal from | Why it blocks | Outcome |
|----|-----|------------|---------------|---------|
| P0.1 | Loop protocol fidelity + async shell + progress arbiter | Codex | Model capability wasted; TUI freezes; false “passes” | Codex parity plan P0 complete |
| P0.2 | Multi-file / complex-task reliability | All | Users abandon after false completes | Live multi-file pass rate published; parity cells vs Codex+OpenCode |
| P0.3 | One-command install + first-run | OpenCode / Codex / Grok | Cannot trial Babel | Clean-machine: install → setup → doctor → one chat fix |
| P0.4 | Unified BYOM / `/models` UX | OpenCode | Feels vendor-locked | Mid-session provider switch without editing 3 config layers |

### P1 — Table-stakes surfaces

| ID | Gap | Steal from | Outcome |
|----|-----|------------|---------|
| P1.1 | ACP stdio server | Grok / OpenCode | Third-party ACP client drives Babel session |
| P1.2 | serve + attach client | OpenCode | Remote/devcontainer TUI attaches to `babel serve` |
| P1.3 | Public headless SDK | Codex / OpenCode | npm SDK wrapping stream-json events |
| P1.4 | Safer sandbox defaults | Codex / Grok | Non-dev profiles fail-closed without `--yolo` |
| P1.5 | Mutating subagents in worktrees | Codex / OpenCode / Grok | Two-worker edit + merge + verifier artifacts |
| P1.6 | Claude/Cursor skill+settings import | Grok | Drop-in `.claude` / `.cursor` discovery |

### P2 — Premium polish (after P0/P1)

| ID | Gap | Steal from |
|----|-----|------------|
| P2.1 | Leader-key / which-key discoverability | OpenCode `ctrl+x` |
| P2.2 | Dedicated plan-approval view | Grok `plan_approval_view` |
| P2.3 | Inline diff viewer excellence | Grok / Codex |
| P2.4 | Desktop/web companion (optional) | OpenCode — **defer** until ACP+reliability |

### Keep (do not dilute)

- Governed `deep` Prompt OS (typed QA gate)
- Evidence / cost ledger / doctor / undo / checkpoints
- Skills catalog + plugin trust model
- Claims-matrix honesty (`claim_ready: false` until measured)

---

## 7. Test contracts (compete against these)

Use these as **acceptance tests** for catch-up PRs. Prefer fixture repos under `babel-cli/fixtures` / parity corpus; record competitor cells when keys/binaries available.

### 7.1 Harness fidelity suite (vs Codex)

| Test ID | Contract | Pass criteria |
|---------|----------|---------------|
| HF-01 | Native tool history | After N tool turns, provider request contains structured tool/assistant/tool-result messages (not a single Markdown user dump) |
| HF-02 | Thinking + tools | When model supports reasoning+tools, thinking is not force-disabled solely because tools are on |
| HF-03 | Async shell | `run_command` sleep 5s — TUI accepts Ctrl+C / renders within 200ms; process cancelled |
| HF-04 | Progress arbiter | Productive investigate (reads only) for ≥8 turns is not killed by zero-write proxy alone |
| HF-05 | Eval honesty | EARLY_BLOCK_RICH / empty patch is **fail** for coding-task gates |

### 7.2 Agency / permissions suite (vs Grok)

| Test ID | Contract | Pass criteria |
|---------|----------|---------------|
| AG-01 | Plan approve | In plan mode, product source writes denied until explicit approve/exit |
| AG-02 | Accept-edits mode | Edits auto-allow; network install still gated |
| AG-03 | YOLO + deny list | Bypass allows listed tools; deny rules still block |
| AG-04 | Skill import | `.claude/skills/*/SKILL.md` appears in tool/skill inventory after inspect |
| AG-05 | ACP smoke | External ACP client completes one read-only prompt session |

### 7.3 Product surface suite (vs OpenCode)

| Test ID | Contract | Pass criteria |
|---------|----------|---------------|
| PS-01 | Install | Documented one-liner or `npm i -g` produces `babel --help` on clean VM |
| PS-02 | First-run | `babel setup --json` → `pass`; `babel doctor --json` → `pass` |
| PS-03 | BYOM | Switch model/provider mid-REPL; next turn uses new backend (evidence in cost ledger) |
| PS-04 | serve/attach | `babel serve` + attach client shows same session events |
| PS-05 | Plan/build toggle | Equivalent of Tab agents: plan cannot mutate app sources; build can |

### 7.4 Reliability suite (vs all three)

| Test ID | Contract | Pass criteria |
|---------|----------|---------------|
| RL-01 | Single-hunk fix | Parity task 1–2 live pass (already historically strong) |
| RL-02 | Multi-file fix | ≥1 multi-file fixture live pass with verifier green |
| RL-03 | False-complete | Claiming done with failing verifier → BLOCKED, not success |
| RL-04 | Competitor cell | Same fixture run on Codex **or** OpenCode **or** Grok recorded in parity matrix |
| RL-05 | Undo | After bad write, `babel undo` / checkpoint restore returns file hash |

### 7.5 Suggested fixture layout

```text
babel-cli/fixtures/competitor-parity/
  README.md                 # how to run Babel vs competitor cells
  small_bug_fix/            # existing parity corpus OK to reuse
  multi_file_refactor/
  failing_test_repair/
  plan_mode_no_write/
  sandbox_escape_attempt/
  scripts/
    run-babel-cell.ps1
    run-codex-cell.ps1      # optional if codex on PATH
    run-opencode-cell.ps1
    run-grok-cell.ps1
    merge-results.mjs       # → claim_ready inputs
```

---

## 8. Implementation waves

Align with existing U-waves / Codex P0 work; do not double-build.

| Wave | Focus | Primary owner docs | Exit proof |
|------|-------|--------------------|------------|
| **W0** | Harness fidelity (HF-01…05) | Codex parity plan P0 | HF suite green; no Markdown-flatten on native tools path |
| **W1** | Reliability + parity cells (RL-*) | This file §7.4 + claims-matrix | RL-02 + RL-04 recorded; false-complete gate hard |
| **W2** | Install + first-run (PS-01/02) | This file | Clean-machine smoke artifact |
| **W3** | BYOM UX (PS-03) | This file + model-policy | Mid-session switch evidence |
| **W4** | ACP + serve/attach (AG-05, PS-04) | Grok upgrade U5 + this file | ACP client + attach demo |
| **W5** | Sandbox defaults (P1.4) | Grok U4 + Codex sandbox docs | Hostile path/network fail-closed |
| **W6** | Mutating worktree subagents (P1.5) | Grok U3 | Two-worker verifier artifacts |
| **W7** | TUI polish (P2.*) | TUI competitive reference | Optional — after W0–W4 |

**Parallelism rule:** W0 is blocking for W1 credibility. W2/W3 can parallel after W0 starts. W4+ after W1 shows multi-file green.

---

## 9. Steal / do-not-steal

### Steal (patterns, not code dumps)

| Pattern | From | Babel landing zone |
|---------|------|--------------------|
| Structured tool message protocol | Codex | `runners/*`, `chatEngine` turn prompt builder |
| ACP session as loop owner | Grok | New `src/acp/` + bridge ChatEngine |
| serve/attach client split | OpenCode | Finish `serve` + attach REPL transport (D2) |
| models.dev-style catalog UX | OpenCode | `babel models` + REPL `/model` |
| Plan approval view | Grok | `src/ui` plan review pane |
| Leader-key discoverability | OpenCode | Keymap + which-key overlay |
| Documented tool ports / notices | Grok | If porting handlers, add THIRD-PARTY notices |
| Worktree workers | OpenCode sandboxes + Codex multi_agent | `sub_agent` + git worktree isolation |

### Do not steal / do not destroy

| Anti-pattern | Why |
|--------------|-----|
| Delete `deep` / Prompt OS to “be more like Grok” | Babel's unique moat |
| Count rich BLOCKED as coding success | Harness lies to itself |
| Claim OS sandbox while only allowlisting | Unsafe marketing |
| Claim ACP before stdio conformance tests | Integration lie |
| Port GPL/unknown-license code without review | Legal risk — prefer Apache/MIT peers |
| Rebuild TUI in Rust/OpenTUI before W0 | Wrong bottleneck |

---

## 10. File map

### Babel (edit targets)

| Area | Paths |
|------|-------|
| Entry / argv | `babel-cli/src/index.ts`, `src/cli/argv.ts` |
| Chat loop | `src/agent/chatEngine.ts`, `chatToolDefinitions.ts`, `toolExecutor.ts` |
| Tools / sandbox | `src/localTools.ts`, `src/sandbox.ts`, `src/tools/*` |
| TUI | `src/interactive/BabelRepl.ts`, `src/ui/*` |
| Pipeline / deep | `src/pipeline.ts`, `src/pipeline/*`, `src/orchestrator/workflowEngine.ts` |
| Providers | `src/runners/*`, `src/config/model-policy` / `config/model-policy.json` |
| Protocol / bridge | `src/protocol/*`, `src/bridge/*` |
| Claims | `docs/status/claims-matrix.md` |

### Competitor clones (read-only reference)

| Area | Codex | Grok | OpenCode |
|------|-------|------|----------|
| Turn loop | `codex-rs/core/src/session/turn.rs` | `xai-grok-shell/.../run_loop.rs`, `sampler_turn.rs` | `packages/opencode/src/session/*` |
| Tools | `codex-rs/core/src/tools/` | `xai-grok-tools/` | `packages/opencode/src/tool/` |
| Sandbox | `codex-rs/sandboxing/` | `xai-grok-sandbox/` | permissions only (`permission/`) |
| TUI | `codex-rs/tui/` | `xai-grok-pager/` | `packages/tui/` |
| CLI | `codex-rs/cli/` | `xai-grok-pager/src/app/cli.rs` | `packages/opencode/src/index.ts` |
| ACP | — | `xai-acp-lib`, `grok agent` | `packages/opencode/src/acp/` |

### Refresh clones

```powershell
$base = '/workspace-root/TUI-CLI-Examples/_compare'
foreach ($n in 'openai-codex','grok-build','opencode') {
  Push-Location (Join-Path $base $n)
  git fetch --depth 1 origin
  git checkout -f FETCH_HEAD
  git log -1 --oneline
  Pop-Location
}
```

---

## 11. Tracking table

Edit as PRs land. Do not mark done without §7 test IDs.

| ID | Item | Wave | Status | PR / evidence | Notes |
|----|------|------|--------|---------------|-------|
| P0.1 | Harness fidelity HF-01…05 | W0 | partial | `feat/p0-async-process-supervisor` | P0-A async shell + cancel settle + HF-05 codingTaskSuccess; P0-B protocol still open |
| P0.2 | Multi-file reliability RL-02 | W1 | | | |
| P0.3 | Install + first-run PS-01/02 | W2 | | | |
| P0.4 | BYOM UX PS-03 | W3 | | | |
| P1.1 | ACP AG-05 | W4 | | | |
| P1.2 | serve/attach PS-04 | W4 | | | |
| P1.3 | Public SDK | W4+ | | | |
| P1.4 | Sandbox defaults | W5 | | | |
| P1.5 | Mutating worktree subagents | W6 | | | |
| P1.6 | Claude/Cursor import AG-04 | W6 | | | |
| P2.1 | Leader-key | W7 | | | |
| P2.2 | Plan approval view | W7 | | | |
| P2.3 | Diff viewer | W7 | | | |

---

## 12. Open risks / UNVERIFIED

- Competitor **binaries not smoke-run** in this audit — architecture from source/docs only.
- Grok **Windows OS sandbox** depth undocumented — do not claim Babel is “behind Windows sandbox” without verifying both.
- OpenCode `serve` without password warns in code — security posture differs from Babel daemon; copy carefully.
- Babel TUI competitive reference (~8.5/10) predates this four-way corpus — refresh TUI matrix after W7.
- Approximate LOC omitted — snapshot/test weight makes raw LOC misleading; use architecture + file maps.

---

## 13. Evidence receipt

```text
Files confirmed in context: babel-cli (ChatEngine, sandbox, interactive, claims-matrix, TUI ref, Grok upgrade audit, Codex parity plan) + three competitor clones under the reference directory
Schemas/contracts confirmed: ChatEngine turn flow; Codex run_turn; Grok ACP session; OpenCode Permission + tool registry
Execution surfaces confirmed: babel bins/commands; codex clap subcommands; grok PagerArgs; opencode yargs commands
Consumers identified: Future Babel implementation waves; parity/claims-matrix; TUI and harness plan owners
Status: evidence complete for planning; binary smoke UNVERIFIED
```

**RISK:** LOW (docs-only)  
**STATUS:** done for planning artifact

---

*End of teardown. Next concrete step: open W0 against [BABEL_CODEX_HARNESS_PARITY_IMPLEMENTATION_PLAN_2026-07-14.md](../plans/BABEL_CODEX_HARNESS_PARITY_IMPLEMENTATION_PLAN_2026-07-14.md) while standing up `fixtures/competitor-parity/` for RL-04 competitor cells.*
