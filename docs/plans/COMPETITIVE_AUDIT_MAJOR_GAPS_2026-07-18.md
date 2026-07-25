# Competitive Audit — 3 MAJOR Gaps Implementation Plan

> **Source:** Swarm audit of Babel CLI vs `/workspace-root/reference-corpus/` (claude-code, codex, claw-code)
> **Date:** 2026-07-18
> **Audit method:** 7 specialized subagents, 70 dimension-level findings, source-verified file:line evidence
> **Overall score:** ~8.5/10 (production-grade), confirmed from prior 2026-07-01 audit
> **Prior audit:** TUI_COMPETITIVE_REFERENCE.md (vault-only)

---

## Context

A full competitive audit was run comparing Babel CLI against the reference corpus at `/workspace-root/reference-corpus/`. Of 70 dimensions audited across 7 areas (Chat Engine, TUI Input, Tool System, Streaming/Rendering, Session/Persistence, Testing/Quality, Multi-Agent/Orchestration):

- **23 dimensions:** Babel leads
- **~40 dimensions:** At par or minor gaps
- **7 MODERATE gaps:** Sub-agent spawn tool, agent role registry, inter-agent communication, micro-compaction, memory extraction integration, protocol transport, specialized tools
- **3 MAJOR gaps:** LSP Integration, Project Memory, IDE Bridge

This plan scopes implementation design for the 3 MAJOR gaps. Each can be planned and implemented in parallel by independent teams/agents since they touch disjoint subsystems.

---

## Gap 1: LSP Integration (MAJOR)

### Current state
Babel has **zero LSP integration**. The only reference is `'lsp'` as an enum value in `src/ui/inlineAutocomplete.ts:33` — it's a placeholder, not a tool. Babel's AST tools (`src/tools/astTools.ts`) provide code outline, definition finding, and reference finding for TypeScript/JavaScript only.

### Competitor reference
**Claude Code** (`claude-code/src/tools/LSPTool/` — 6 files):
- `LSPTool.ts` — tool definition implementing `Tool<…>` with `isLsp: true`
- `schemas.ts` — Zod schemas for LSP operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`
- `formatters.ts` — formats LSP responses for model consumption
- `symbolContext.ts` — context gathering with LSP
- `prompt.ts` — LSP tool prompt instructions
- `UI.tsx` — React rendering for LSP interactions

Supporting infrastructure:
- `src/services/lsp/manager.ts` — LSP server manager (spawn, configure, restart)
- `src/services/lsp/types.ts` — LSP type definitions
- Plugin-based server config: `plugin.lspServers` in plugin definitions
- LSP recommendation dialog for suggesting plugins
- Initialized via `initializeLspServerManager()` in `main.tsx:189`

### What to build

**Phase 1a — Core LSP infrastructure:**
1. `src/services/lsp/manager.ts` — LSP server lifecycle manager
   - Spawn/configure/restart language servers via stdio
   - Per-workspace server registry keyed by language ID
   - Server health checks and automatic restart
   - Config from `~/.babel/lsp-servers.json` (user) + project `.babel/lsp-servers.json`
2. `src/services/lsp/types.ts` — TypeScript types mirroring LSP protocol (initialize, shutdown, textDocument/didOpen, etc.)
3. `src/services/lsp/client.ts` — JSON-RPC 2.0 client over stdio (reuse patterns from `src/tools/mcpTransport.ts`)

**Phase 1b — LSP Tool:**
4. `src/tools/lspTool.ts` — Tool definition registered in `toolCatalog.ts` and `chatToolDefinitions.ts`
   - Operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`
   - Input schema: `{ operation, filePath, line, character, query? }`
   - Output: structured results formatted for model consumption
   - Permission: `read_only`, `policyTags: ['lsp']`
5. `src/tools/lspFormatters.ts` — Response formatters (location → file:line, hover → markdown, symbols → tree)

**Phase 1c — Prompt integration:**
6. LSP tool description in chat system prompt — tells model when to use LSP vs grep/glob/ast
7. LSP results injected into tool context with appropriate truncation

**Phase 1d — Autocomplete integration (stretch):**
8. Wire LSP completions into `TypeaheadEngine` or `InlineAutocomplete` as an additional source

### Files that will change
- **New:** `src/services/lsp/manager.ts`, `src/services/lsp/types.ts`, `src/services/lsp/client.ts`, `src/tools/lspTool.ts`, `src/tools/lspFormatters.ts`
- **Modified:** `src/tools/toolCatalog.ts`, `src/tools/toolContracts.ts`, `src/agent/chatToolDefinitions.ts`, `src/agent/actions.ts`, `src/localTools.ts`
- **Tests:** `src/tools/lspTool.test.ts`, `src/services/lsp/manager.test.ts`

### Success criteria
- [ ] `goToDefinition` returns correct file:line for TS, Python, Rust projects
- [ ] `findReferences` returns all references across workspace
- [ ] `hover` returns type info and documentation
- [ ] LSP server auto-starts on first tool call, recovers from crashes
- [ ] Works with at least TypeScript (built-in via `typescript-language-server`) and Python (`pyright`)
- [ ] Unit tests with mock LSP server

---

## Gap 2: Project Memory — Typed Memory Taxonomy (MAJOR)

### Current state
Babel has two memory systems that **don't talk to each other**:
- `projectMemory.ts` — reads a single `BABEL.md` blob, proposes write-backs to `BABEL.md.proposed`
- `memoryExtraction.ts` — LLM-based extraction from execution reports → `.babel/project_memories.md` (never surfaced in prompts)

There is no typed taxonomy, no relevance search, no auto-discovery, no frontmatter, no team/private scoping.

### Competitor reference
**Claude Code** (`claude-code/src/memdir/`):
- `memoryTypes.ts` — 4 types: `user`, `feedback`, `project`, `reference` with structured prompt guidance for each
- `memdir.ts` — `MEMORY.md` entrypoint (200-line / 25KB cap), truncation warning
- `memoryScan.ts` — `scanMemoryFiles()` directory scanning, `findRelevantMemories()` Sonnet-based relevance selection
- `paths.ts` — `~/.claude/projects/{sanitized-git-root}/memory/` layout, daily logs at `logs/YYYY/MM/YYYY-MM-DD.md`
- `findRelevantMemories.ts` — LLM-driven relevance selection per query
- Frontmatter format: `---\nname: <slug>\ndescription: <one-line>\nmetadata:\n  type: user|feedback|project|reference\n---`
- Team memory: `teamMemPaths.ts` / `teamMemPrompts.ts`
- Multi-level gate: env var → settings.json → project-level opt-out

### What to build

**Phase 2a — Memory directory structure:**
1. Migrate from single `BABEL.md` to `~/.babel/projects/{git-root}/memory/` directory
   - `MEMORY.md` — index file (one line per memory, links to files)
   - `*.md` files — individual memory files with YAML frontmatter
   - `logs/YYYY/MM/YYYY-MM-DD.md` — daily session logs
2. `src/services/memory/memoryTypes.ts` — typed memory taxonomy
   - `user` — who the user is (role, expertise, preferences)
   - `feedback` — guidance on how to work (corrections, confirmed approaches)
   - `project` — ongoing work, goals, constraints
   - `reference` — pointers to external resources (URLs, dashboards, tickets)
3. `src/services/memory/memoryStore.ts` — CRUD operations
   - Scan memory directory, parse frontmatter
   - Write new memories with dedup (update existing if same slug)
   - Delete/prune stale memories
   - Read `MEMORY.md` index

**Phase 2b — Relevance search:**
4. `src/services/memory/memoryRelevance.ts` — relevance selection
   - Fast path: keyword/substring match against title + description
   - LLM path: cheap model selects relevant memories from index (like Claude Code's `findRelevantMemories.ts`)
   - Result: filtered set of memory file contents injected into system prompt

**Phase 2c — Integration:**
5. Wire into `chatEngine.ts` system prompt assembly
   - After reading `BABEL.md`/`CLAUDE.md`/`PROJECT_CONTEXT.md`, also run relevance search
   - Inject relevant memories as `## Project Memory` section
6. Connect `memoryExtraction.ts` output → memory store
   - Extracted memories write directly to `memory/` directory
   - `MEMORY.md` index auto-updated
7. Auto-extraction background agent
   - After significant runs, spawn cheap model to extract memories
   - Write to `memory/` directory (never auto-merge without user review for `feedback` type)

**Phase 2d — BABEL.md compatibility:**
8. `BABEL.md` remains as a fallback (read into system prompt as `project` type memory)
9. New sessions prefer memory directory; fall back to `BABEL.md` if directory is empty

### Files that will change
- **New:** `src/services/memory/memoryTypes.ts`, `src/services/memory/memoryStore.ts`, `src/services/memory/memoryRelevance.ts`, `src/services/memory/memoryIndex.ts`
- **Modified:** `src/services/projectMemory.ts`, `src/services/memoryExtraction.ts`, `src/agent/chatEngine.ts` (system prompt assembly), `src/agent/chatStackCompile.ts`
- **Tests:** `src/services/memory/memoryStore.test.ts`, `src/services/memory/memoryRelevance.test.ts`

### Success criteria
- [ ] Memory directory created on first session with `MEMORY.md` index
- [ ] 4 memory types supported with frontmatter validation
- [ ] Relevance search returns appropriate memories for a given task
- [ ] `memoryExtraction.ts` writes extracted memories to directory
- [ ] `BABEL.md` continues to work as fallback
- [ ] Daily logs written to `logs/YYYY/MM/YYYY-MM-DD.md`
- [ ] Unit tests for store CRUD, relevance scoring, frontmatter parsing

---

## Gap 3: IDE Bridge / Remote Sessions (MAJOR)

### Current state
Babel is purely a local terminal CLI. There is no HTTP server, no WebSocket server, no SSE server, no session ingress/egress mechanism, no remote control capability.

### Competitor reference
**Claude Code** (`claude-code/src/bridge/` — ~30 files):
- `replBridge.ts` — environment registration, session creation, work polling, ingress WebSocket
- `sessionRunner.ts` — spawns child CLI process with `--print --sdk-url --session-id --input-format stream-json --output-format stream-json`, NDJSON over stdin/stdout
- `replBridgeTransport.ts` — two transport protocols: HybridTransport (v1: WS reads + HTTP POST writes), SSETransport+CCRClient (v2: SSE reads + CCR writes)
- `bridgeMessaging.ts` — message routing (ingress, egress, control requests/responses)
- `bridgePermissionCallbacks.ts` — permission requests from tools forwarded to remote client
- `bridgePointer.ts` — crash-recovery pointer for session resumption across process restarts
- `bridgeStatusUtil.ts` — status display for bridge sessions
- `bridgeUI.ts` — UI components for bridge state
- `codeSessionApi.ts` / `createSession.ts` — session creation API
- `inboundAttachments.ts` / `inboundMessages.ts` — inbound content from remote users
- `jwtUtils.ts` — JWT handling for session ingress auth
- `pollConfig.ts` / `pollConfigDefaults.ts` — configurable polling for work items
- `trustedDevice.ts` — trusted device management
- `flushGate.ts` — ensures messages aren't interleaved during initial history replay
- `BoundedUUIDSet` — echo dedup across transport swaps
- SSE sequence number persistence for exactly-once event delivery

### Caveat
This gap is **scoped to remote/IDE use cases**. If Babel's target remains exclusively local terminal users, this is NOT a gap to close. However, Babel already has the in-process protocol stub (`src/protocol/` + ADR-010) from Phase D1–D2, so the foundation exists.

### What to build (if prioritized)

**Phase 3a — Session server:**
1. `src/bridge/sessionServer.ts` — HTTP + WebSocket server
   - Session creation endpoint (POST /sessions)
   - WebSocket upgrade for bidirectional streaming
   - JWT-based authentication
   - Session listing and status
2. `src/bridge/sessionRunner.ts` — out-of-process session spawning
   - Spawn `babel` as child process with `--bridge --session-id <id>`
   - NDJSON over stdin/stdout for bidirectional communication
   - Heartbeat, crash recovery, graceful shutdown

**Phase 3b — Transport layer:**
3. `src/bridge/transport.ts` — transport abstraction
   - In-process transport (current — default)
   - WebSocket transport (for remote)
   - SSE transport (for server→client streaming)
   - NDJSON framing, sequence numbers, echo dedup

**Phase 3c — Client protocol:**
4. `src/bridge/client.ts` — remote client SDK
   - Connect to session server
   - Send prompts, receive streaming responses
   - Permission callbacks forwarded to client
   - Session resume/reconnect

**Phase 3d — IDE plugin stubs:**
5. VS Code extension stub (minimal — connect to Babel bridge, send/receive)
6. JetBrains plugin stub (same)

### Files that will change
- **New:** `src/bridge/` (sessionServer, sessionRunner, transport, client, auth, messaging, permissions)
- **Modified:** `src/protocol/` (extend existing types/messages for remote transport), `src/interactive/execution/chatTransport.ts`
- **Tests:** Integration tests with mock remote client

### Success criteria
- [ ] Session server starts and accepts connections
- [ ] Remote client can send prompts and receive streaming responses
- [ ] Permission requests forwarded to remote client
- [ ] Session resume across disconnects
- [ ] Crash recovery via pointer file

---

## Implementation Strategy

### Parallelism
All 3 gaps touch **disjoint subsystems** and can be implemented in parallel:

| Gap | Primary subsystems | Conflicts with |
|-----|-------------------|----------------|
| LSP Integration | `src/services/lsp/`, `src/tools/lspTool.ts`, `src/agent/chatToolDefinitions.ts` | None |
| Project Memory | `src/services/memory/`, `src/services/projectMemory.ts`, `src/agent/chatEngine.ts` | Minor: system prompt assembly in `chatEngine.ts` (both LSP and Memory touch this) |
| IDE Bridge | `src/bridge/`, `src/protocol/` | None |

**File conflict to manage:** Only `chatEngine.ts` system prompt assembly is touched by both Gap 1 (LSP tool description in prompt) and Gap 2 (memory injection in prompt). These are separate sections of the system prompt and can be merged sequentially.

### Recommended order (if not fully parallel)
1. **Gap 2 (Project Memory)** first — highest user-facing impact, touches prompt assembly
2. **Gap 1 (LSP Integration)** second — new capability, independent subsystem
3. **Gap 3 (IDE Bridge)** third — largest scope, depends on roadmap decision

### MODERATE gaps that can be woven in
While implementing the MAJOR gaps, several MODERATE gaps can be addressed as they touch the same files:
- **Micro-compaction** (Chat Engine) — can be done alongside memory work
- **Agent role registry** (Multi-Agent) — independent, can be done in parallel
- **LLM-accessible sub-agent spawn tool** (Multi-Agent) — independent
- **Inter-agent communication** (Multi-Agent) — independent

---

## Verification

After each gap implementation:
```powershell
cd ./babel-cli
npm run typecheck
npm test
npm run build
```

After all 3 gaps:
```powershell
# Full validation suite
pwsh tools/validate-all.ps1
pwsh tools/check-architectural-budget.ps1
```

---

## Audit Evidence

Full audit reports from 7 specialized subagents are available in session transcript. Key files read:

**Babel (70+ files):** `chatEngine.ts`, `chatCompaction.ts`, `stallDetector.ts`, `completionGatePolicy.ts`, `budgetKillPolicy.ts`, `diffCritic.ts`, `planThenExecute.ts`, `phaseToolPolicy.ts`, `chatTaskClass.ts`, `chatEngineObservability.ts`, `promptInput.ts`, `vimEngine.ts`, `typeaheadEngine.ts`, `pasteBurst.ts`, `keybindings.ts`, `keybindingRemap.ts`, `waterfall.ts`, `markdownAccumulator.ts`, `twoRegionStreaming.ts`, `component.ts`, `screenManager.ts`, `paneManager.ts`, `frameScheduler.ts`, `outputBuffer.ts`, `historyCells/` (all 8), `threadStore.ts`, `branching.ts`, `checkpoints.ts`, `projectMemory.ts`, `memoryExtraction.ts`, `actions.ts`, `toolExecutor.ts`, `policy.ts`, `sandbox.ts`, `toolRenderers.ts`, `toolPermissions.ts`, `workflowEngine.ts`, `agentRunCoordinator.ts`, `swarmRunner.ts`, `agentTeams.ts`, `implementWorktreeAgent.ts`, `pipeline.ts`

**Competitors (50+ files):** Claude Code — `QueryEngine.ts`, `query.ts`, `compact.ts`, `autoCompact.ts`, `microCompact.ts`, `PromptInput.tsx`, `VirtualMessageList.tsx`, `AgentTool/`, `Tool.ts`, `replBridge.ts`, `sessionRunner.ts`, `memdir/` (5 files). Codex — `chat_composer.rs`, `history_cell/`, `chunking.rs`, `commit_tick.rs`, `table_holdback.rs`, `table_key_value.rs`, `store.rs`, `types.rs`, `live_thread.rs`, `control.rs`, `role.rs`, `spawn.rs`, `review.rs`, `turn.rs`, `rollout_budget.rs`, `turn_diff_tracker.rs`, `tool_definition.rs`

---

*Plan generated: 2026-07-18 · Next session: run `/handoff-resume` to load this plan and begin implementation.*
