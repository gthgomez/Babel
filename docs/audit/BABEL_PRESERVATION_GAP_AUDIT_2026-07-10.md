<!--
status: ACTIVE
last_verified: 2026-07-10
role: CANONICAL
supersedes: informal ChatGPT cross-reference audit (same date)
-->
# Babel Preservation Gap Audit — Coding Agent First

> **Role**: Priority-ranked gap audit derived from the AI Preservation Strategies cross-reference. Focuses on closing coding-agent gaps first, then expanding to adjacent capabilities where they strengthen the core product.
>
> **Source material**: ChatGPT "AI Preservation Strategies" conversation (exported 2026-07-10) — a what-to-preserve-if-AI-disappeared framework covering personal knowledge systems, coding agents, voice assistants, automation, browser agents, research agents, image/video generation, speech, OCR, and a top-10 software shortlist.
>
> **Method**: Cross-referenced all categories against Babel source (`babel-cli/src/`), docs (`docs/architecture/`, `docs/audit/`), and state audit (`BABEL_CODING_AGENT_STATE_2026-07-08.md`). Gaps are ranked by: (a) proximity to Babel's core coding-agent identity, (b) feasibility given current architecture, (c) preservation value if cloud AI disappeared.

---

## 1. How to use this doc

| Need | Section |
|------|---------|
| What Babel already nails (don't rebuild) | §2 |
| What to build next (ranked gaps) | §3 |
| Gap detail + implementation sketch per gap | §4 |
| What NOT to build (anti-scope) | §5 |
| Estimated effort + sequencing | §6 |
| Verification after each gap closes | §7 |

**Rule**: Close Tier 0 gaps before opening Tier 1, Tier 1 before Tier 2, etc. Each tier is self-contained — you can ship a tier and stop.

---

## 2. What Babel Already Nails (Preservation Strengths)

These are the capabilities Babel already has that align with the preservation framework. Do not rebuild or dilute these.

| # | Capability | Babel evidence | Preservation value |
|---|-----------|---------------|-------------------|
| 1 | **Autonomous coding agent loop** | ChatEngine (`chatEngine.ts`) — multi-turn, no approval prompts, circuit breaker safety | Replaces Claude Code / Codex / Cursor agent |
| 2 | **Structured governance pipeline** | Deep mode: Orchestrator → SWE → QA → Executor + typed contracts | Replaces ad-hoc review processes |
| 3 | **Multi-agent orchestration** | Sub-agents + DAG workflow engine + pipeline stages | Replaces LangGraph / CrewAI for coding tasks |
| 4 | **Tool-calling surface** | Edit tools, read tools, search, shell, sub-agents, todo, verifier | Core agent capability |
| 5 | **Verification + evidence** | Green verifier gate, diff critic, static checks, adversarial QA | Replaces manual code review for mechanical checks |
| 6 | **Semantic code search** | `semantic_search`, `grep`, `glob`, repo map generation | Replaces Sourcegraph-lite indexing |
| 7 | **Repository understanding** | Repo map → system prompt, BABEL.md project memory | Replaces manual codebase onboarding |
| 8 | **Session continuity** | Checkpoints, handoffs, chronicle store, cost tracking | Replaces manual context-switching |
| 9 | **Behavior/Knowledge separation** | Behavioral OS v11 + Domain Architects + Skills + Adapters | Architecture that survives model churn |
| 10 | **Safety without approval prompts** | Sandbox + circuit breaker + audit trail | Different UX bet that preserves autonomy |

**Bottom line**: If cloud AI disappeared tomorrow and you could only keep one tool from Babel's stack, the ChatEngine + tool surface + repo understanding would be the highest-preservation-value artifact. Everything below is about filling the gaps around that core.

---

## 3. Ranked Gap Tiers

### Tier 0 — Existential: Local Inference (P0)

**What's missing**: Babel depends entirely on cloud LLM providers (DeepSeek, Llama, Qwen). If those APIs disappeared, Babel's runtime goes dark. The ChatGPT preservation framework explicitly calls out **Ollama** and **LM Studio** as essential local model management — Babel has zero integration with either.

**Why this is Tier 0**: Every other gap is moot if the agent can't run. Local inference is the single capability that makes Babel survive a cloud AI shutdown.

| Gap ID | Gap | Current state |
|--------|-----|---------------|
| **L0** | Local model backend (Ollama / LM Studio / llama.cpp) | Zero integration. `model-policy.json` assumes cloud providers only. |
| **L1** | Local model routing in waterfall | No local tiers in stage waterfalls. |
| **L2** | Offline-first mode | No "airplane mode" that works without internet. |

### Tier 1 — Core Coding Agent Completeness (P1)

**What's missing**: Capabilities that a serious coding agent should have but Babel lacks. These are table-stakes for the "clone Claude Code / Cursor / Aider" preservation goal.

| Gap ID | Gap | Current state |
|--------|-----|---------------|
| **C1** | **IDE / editor integration** | TUI-only. No VS Code / Cursor / JetBrains extension. The ChatGPT shortlist puts Cursor at #1 ("Best AI coding UX") and Continue.dev at #8. Babel has the BABEL_BIBLE.md editor path (tell your editor's AI to "use Babel") but no direct plugin. |
| **C2** | **Git workflow automation** | No commit generation, branch creation, PR drafting, or merge conflict resolution built into the agent loop. The `github-workflow` skill exists as a Claude Code host skill, not as a Babel-native capability. |
| **C3** | **Autonomous debugging loop** | Babel has verifier + static checks + diff critic, but no closed-loop "run → fail → diagnose → fix → verify" cycle. SWE-A at 2/10 correct shows the gap: agent makes plausible but wrong fixes. |
| **C4** | **Test generation from code** | No capability to read code and generate missing tests. Verifier discovers existing tests but doesn't fill gaps. |
| **C5** | **Code intelligence at scale** | Repo map is good for small/medium repos. No cross-repo indexing, no dependency graph analysis, no call-graph-aware search. The ChatGPT response calls out "a code intelligence/indexing engine that understands large repositories semantically" — Babel's semantic_search is vector-only, not structural. |
| **C6** | **Local-first caching / offline model serving** | Even with cloud providers, no persistent embedding cache, no pre-computed repo index, no offline-capable mode. Every session re-indexes from scratch. |

### Tier 2 — Adjacent Capabilities (P2)

**What's missing**: Capabilities adjacent to coding that would make Babel a more complete preservation target. These are not core to "coding agent" but directly support coding workflows.

| Gap ID | Gap | Current state |
|--------|-----|---------------|
| **A1** | **Browser automation for testing** | No Playwright / Puppeteer / browser-use integration. Can't run E2E tests, can't screenshot, can't interact with web UIs. This is a major gap for web developers — the ChatGPT framework lists "Browser Agent" as category #5. |
| **A2** | **Document understanding (code-adjacent)** | No OCR, no PDF parsing, no README/image extraction. Can't read architecture diagrams, can't ingest API docs from PDFs, can't parse screenshots of errors. |
| **A3** | **Voice input into coding prompt** | Blueprinted (`VOICE_DICTATION_BLUEPRINT_AUDIT_2026-07-08.md`, YELLOW verdict). Ctrl+Shift+V hotkey plumbing exists in `promptInput.ts`. No mic/STT pipeline. |
| **A4** | **General automation triggers** | No cron/scheduled tasks, no webhook listener, no filesystem watcher that triggers agent runs. Daemon exists but is job-queue-only (push, don't pull). |
| **A5** | **Multi-project / workspace awareness** | Babel works in one repo at a time. No cross-repo task coordination, no monorepo-aware routing, no workspace-level project memory. |

### Tier 3 — Ecosystem (P3)

**What's missing**: Capabilities that make Babel usable by others and embeddable in other tools. Lower priority for preservation but critical for adoption.

| Gap ID | Gap | Current state |
|--------|-----|---------------|
| **E1** | **Portable skill export** | Babel skills are catalog-locked. No `SKILL.md` export for Claude Code / Cursor / Codex. The ECC comparison explicitly calls this out as a high-severity gap. |
| **E2** | **Local model serving / sharing** | No way to share a tuned model + skill stack as a single distributable bundle. |
| **E3** | **SDK / library mode** | Babel is CLI-only. No `import { ChatEngine } from 'babel'` for embedding in other Node.js tools. |
| **E4** | **Plugin/extension marketplace** | Plugin system exists (`services/plugins.ts`) but no discovery, no community contributions, no install-from-url. |

---

## 4. Gap Detail + Implementation Sketch

### 4.0 — L0: Local Model Backend

**Preservation value**: Existential. Without this, Babel dies with cloud AI.

**What to build**:

1. **Ollama provider adapter** (`babel-cli/src/providers/ollama.ts`)
   - OpenAI-compatible chat endpoint (`http://localhost:11434/v1`)
   - Model list discovery via `ollama list`
   - Streaming support (Ollama supports SSE)
   - Token counting (Ollama doesn't expose token counts natively — estimate or use fallback)

2. **LM Studio provider adapter** (`babel-cli/src/providers/lmstudio.ts`)
   - Same OpenAI-compatible endpoint pattern
   - Local model discovery

3. **Local tier in model waterfalls** (`config/model-policy.json`)
   - Add `local` tier below cloud tiers in each stage waterfall
   - Example: `["deepseek-v4-pro", "deepseek-v4-flash", "local:qwen3-32b", "local:llama-4-scout"]`
   - Fallback policy: cloud → local, not local → cloud (preservation priority)

4. **Offline mode flag** (`--offline` / `BABEL_OFFLINE=1`)
   - Skips cloud provider health checks
   - Forces local-only model selection
   - Disables features that require internet (web search, some MCP servers)

**Files to touch**:
- `babel-cli/src/config/model-policy.json` — new local tiers
- `babel-cli/src/providers/` — new ollama.ts, lmstudio.ts
- `babel-cli/src/agent/chatEngine.ts` — offline mode gating
- `babel-cli/src/cli/sharedOptions.ts` — `--offline` flag
- `config/model-policy.json` — waterfall entries

**Effort**: ~5-8 days for Ollama + offline mode. LM Studio adds ~2-3 days.

**Exit criterion**: `babel --offline "fix the bug in src/parser.ts"` runs a complete agent loop against a local Ollama model.

---

### 4.1 — C1: IDE / Editor Integration

**Preservation value**: High. Cursor and Continue.dev are #1 and #8 on the preservation shortlist. Babel doesn't need to beat them — it needs to work alongside them.

**What to build**:

1. **VS Code extension** (highest leverage)
   - Sidebar panel that embeds Babel's chat TUI via terminal link or webview
   - Command palette entries: `Babel: Chat`, `Babel: Plan`, `Babel: Deep`
   - File context passing: right-click file → "Send to Babel"
   - Diff preview: show Babel's proposed changes in VS Code diff view before applying

2. **Continue.dev provider** (lower effort, high reach)
   - Implement Continue's custom provider interface
   - Route Continue chat messages to Babel ChatEngine
   - Stream diffs back into Continue's edit surface

3. **Cursor integration** (via BABEL_BIBLE.md path — already exists, document better)
   - Improve the "tell Cursor to use Babel" workflow
   - Ship a `.cursor/rules/babel.md` rule file that Cursor auto-loads
   - Document the Cursor → Babel handoff pattern

**Files to touch**:
- New: `editors/vscode/` extension directory
- New: `editors/continue/` provider
- `BABEL_BIBLE.md` — Cursor integration docs
- `docs/guides/` — editor integration guide

**Effort**: VS Code extension ~8-12 days. Continue provider ~3-5 days. Cursor rules ~1 day.

**Exit criterion**: User types a task in VS Code, Babel runs it, user sees the diff in-editor and approves/rejects.

---

### 4.2 — C2: Git Workflow Automation

**Preservation value**: High. Commit generation and PR creation are core coding workflow steps that every competitor has.

**What to build**:

1. **Git tool set** (add to `chatToolDefinitions.ts`)
   - `git_diff` — show working tree changes
   - `git_log` — recent commit history
   - `git_status` — porcelain status
   - `git_branch` — create/switch branches
   - `git_commit` — stage + commit with generated message
   - `git_push` — push to remote (with safety gate)

2. **Commit message generation** (integrate into completion)
   - After successful edit + verify, propose commit message
   - Follow conventional commits format
   - Include Co-Authored-By trailer

3. **PR drafting** (integrate into completion)
   - After commit + push, offer to create PR
   - Generate PR title + body from commit history + task context
   - Include `🤖 Generated with Babel` trailer

**Safety invariant**: Git tools are read-only by default in chat mode. `git_commit` and `git_push` require explicit user confirmation or are gated behind `BABEL_ALLOW_GIT_WRITES=1`.

**Files to touch**:
- `babel-cli/src/agent/chatToolDefinitions.ts` — new git tools
- `babel-cli/src/agent/tools/gitTools.ts` — implementation
- `babel-cli/src/agent/chatEngine.ts` — completion hook for commit/PR
- `babel-cli/src/config/chatEngineLimits.ts` — git write gating

**Effort**: ~5-7 days.

**Exit criterion**: `babel "fix the null check and ship it"` → agent edits → verifies → commits with message → pushes → opens PR.

---

### 4.3 — C3: Autonomous Debugging Loop

**Preservation value**: High. The ChatGPT framework lists "autonomous debugging" as a key individual capability. Babel's SWE-A 2/10 correct rate shows the current gap between "makes a fix" and "makes the right fix."

**What to build**:

1. **Closed-loop debug cycle** in ChatEngine
   ```
   edit → verify → FAIL → diagnose (read error + relevant source) → edit → verify → PASS → complete
   ```
   - Max N retry cycles (default 3) before surfacing to user
   - Each retry gets the full failure output + diff from previous attempt
   - Track what was tried to avoid repeating the same wrong fix

2. **Root cause analysis pass** before first edit
   - When test failure exists: read test + read code under test → identify root cause → plan fix
   - This exists partially in diff critic but isn't a structured pre-edit step

3. **Bisect support** for regression tasks
   - `git bisect` integration for "this used to work" bugs
   - Agent runs verifier at each bisect step

**Files to touch**:
- `babel-cli/src/agent/chatEngine.ts` — retry loop
- `babel-cli/src/agent/debugCycle.ts` — new module
- `babel-cli/src/agent/completionGatePolicy.ts` — retry-aware completion

**Effort**: ~5-8 days.

**Exit criterion**: SWE-A correct rate moves from 2/10 to ≥5/10 (stretch: ≥7/10 with C5 code intelligence).

---

### 4.4 — C4: Test Generation

**Preservation value**: Medium-High. "Testing" is listed as a key automation target in the ChatGPT framework. Every coding agent should fill its own test gaps.

**What to build**:

1. **Coverage gap detection**
   - After an edit, identify functions/methods changed
   - Check if tests exercise those paths
   - Flag untested changes before completing

2. **Test generation tool** (`generate_test`)
   - Given a function + existing test file, generate missing test cases
   - Follow existing test patterns (framework, naming, assertions)
   - Run generated tests to verify they pass

3. **Test quality critic**
   - Review generated tests for: assertions that can't fail, missing edge cases, overly mock-heavy tests
   - Integrated with existing diff critic infrastructure

**Files to touch**:
- `babel-cli/src/agent/testGeneration.ts` — new module
- `babel-cli/src/agent/chatToolDefinitions.ts` — `generate_test` tool
- `babel-cli/src/agent/diffCritic.ts` — test quality dimension

**Effort**: ~5-7 days.

**Exit criterion**: After fixing a bug, the agent proposes a test that would have caught it — and the test passes.

---

### 4.5 — C5: Code Intelligence at Scale

**Preservation value**: High. The ChatGPT framework specifically calls out "a code intelligence/indexing engine that understands large repositories semantically" as priority #10 for the user. Babel's current repo map is a single-pass LLM summary, not an index.

**What to build**:

1. **Structural code index** (persistent, incremental)
   - AST-level extraction: functions, classes, interfaces, exports, imports
   - Call graph edges: who calls whom
   - Type graph: interfaces → implementations, type usage
   - Store in SQLite (already a dependency via chronicle)

2. **Dependency-aware search**
   - "Find all callers of `parseUserInput`" → returns call graph, not just text matches
   - "What depends on this interface?" → reverse dependency lookup
   - Integrate with existing `semantic_search` as a hybrid: vector + structural

3. **Incremental indexing**
   - Re-index only changed files on edit
   - Watch mode for long-running sessions
   - Persist index across sessions (chronicle store)

4. **Cross-repo awareness** (stretch)
   - Index workspace dependencies (monorepo packages, linked libs)
   - "This change breaks the API — here are the 3 callers in `other-package/`"

**Files to touch**:
- `babel-cli/src/agent/codeIndex.ts` — new module
- `babel-cli/src/agent/repoMap.ts` — integrate index into map generation
- `babel-cli/src/agent/chatToolDefinitions.ts` — new search tools
- `babel-cli/src/tools/chronicleMemory.ts` — index storage

**Effort**: ~10-15 days for structural index + dependency search. Cross-repo adds ~5-8 days.

**Exit criterion**: `babel "refactor the auth module — find every caller and make sure they still work"` → agent uses the index to enumerate all callers, edits them, and verifies.

---

### 4.6 — C6: Local-First Caching

**Preservation value**: Medium. Enables offline-capable mode (L2) and reduces cloud costs even when online.

**What to build**:

1. **Persistent embedding cache**
   - Cache file embeddings across sessions
   - Invalidate on file content hash change
   - Works with local embedding models (e.g., `nomic-embed-text` via Ollama)

2. **Pre-computed repo index**
   - Run `babel index` to pre-compute: embeddings, AST index, dependency graph
   - Load index at session start instead of re-computing
   - `babel index --watch` for continuous updates

3. **Prompt cache priming**
   - Pre-load system prompt + repo context into provider cache on session start
   - Already partially done with DeepSeek prompt cache; extend to local providers

**Files to touch**:
- `babel-cli/src/agent/embeddingCache.ts` — new module
- `babel-cli/src/agent/codeIndex.ts` — persistence layer
- `babel-cli/src/cli/` — `babel index` command

**Effort**: ~5-8 days.

**Exit criterion**: Second `babel` session in the same repo loads instantly from cache (no re-indexing).

---

### 4.7 — A1: Browser Automation for Testing

**Preservation value**: Medium. The ChatGPT framework lists "Browser Agent" as its own category (#5). For Babel as a coding agent, the primary use is E2E testing and web app verification.

**What to build**:

1. **Playwright tool set** (add to chat tool definitions)
   - `browser_navigate` — go to URL
   - `browser_screenshot` — capture viewport
   - `browser_click` / `browser_type` — interact
   - `browser_console` — read console output
   - `browser_network` — read network requests

2. **Playwright lifecycle** (via daemon)
   - Browser instance managed by daemon (survives chat turns)
   - Pool of browser contexts for parallel tests
   - Auto-install Playwright browsers on first use

3. **E2E test workflow**
   - Agent writes Playwright test → runs it → sees screenshot of failure → fixes → reruns
   - Integrates with the debug loop (C3)

**Safety invariant**: Browser tools are sandboxed. No access to `localhost` in shared network mode. `BABEL_BROWSER_MODE=off|local|remote`. Default `local`.

**Files to touch**:
- `babel-cli/src/agent/browserTools.ts` — new module
- `babel-cli/src/agent/chatToolDefinitions.ts` — browser tools
- `babel-cli/src/daemon/` — browser instance management
- `babel-cli/src/sandbox.ts` — browser sandboxing

**Effort**: ~8-12 days.

**Exit criterion**: `babel "the login form is broken — test it"` → agent navigates to localhost:3000, fills form, screenshots error, fixes code, re-tests, confirms fix.

---

### 4.8 — A3: Voice Input

**Preservation value**: Medium. The ChatGPT framework lists "Local Voice Assistant" as category #3 and Whisper as #10 on the software shortlist. Babel already has a thorough blueprint audit.

**What to build** (scoped to TUI-only per audit recommendation):

1. **Phase 0–2 from blueprint**: Mic capture → VAD → STT → promptInput
   - Use `node-record-lpcm16` for mic capture in worker thread
   - Silero VAD via ONNX runtime
   - Groq/Deepgram streaming STT (cloud) OR whisper.cpp (local, via Ollama)
   - Insert raw transcription into `promptInput.ts`

2. **Dual-phase refinement** (Phase 3–4)
   - Raw text appears immediately (~400ms)
   - Background LLM pass cleans up code-specific terms ("get diff" → "git diff")
   - Replace raw with refined in promptInput

3. **Voice as input modality, not separate mode**
   - Hotkey toggles voice input (Ctrl+Shift+V plumbing exists)
   - Voice input feeds into the same ChatEngine path as typed input
   - No separate "voice mode" — it's just another way to type

**Files to touch**:
- `babel-cli/src/ui/voiceInput.ts` — new module
- `babel-cli/src/ui/promptInput.ts` — voice toggle integration
- `babel-cli/src/services/sttClient.ts` — new module

**Effort**: ~10-15 days for phases 0–4 (TUI-only). Audit blueprint says 9–15 days for those phases.

**Exit criterion**: Hold Ctrl+Shift+V, speak "fix the null pointer in the auth handler", release, text appears in prompt and agent executes.

---

## 5. Anti-Scope — What NOT to Build

These are capabilities from the ChatGPT preservation framework that are outside Babel's coding-agent identity. Explicitly scoping them out prevents mission drift.

| Category | Why NOT build |
|----------|--------------|
| **Image generation** (Stable Diffusion, Flux, ComfyUI) | Different product category. No architectural adjacency to coding agent. |
| **Video generation** (Wan, CogVideo, Hunyuan) | Same — different category, massive hardware requirements. |
| **System-wide voice dictation** (Wispr Flow clone) | Voice audit verdict: "build as separate Tauri/Electron app." Babel's surface is the terminal. |
| **Personal knowledge system** (Open WebUI, AnythingLLM clone) | Babel indexes code, not personal documents. Personal RAG is a different product. |
| **n8n-style visual automation** | Babel is a CLI/TUI. Visual workflow builders are a different UX category. Daemon + DAG engine cover headless automation. |
| **OCR / document AI** (receipts, invoices, layout parsing) | Outside coding-agent scope. A2 (document understanding) is scoped to code-adjacent docs only. |
| **Open WebUI / LibreChat** | Local chat UIs are valuable but Babel is a coding agent, not a chat frontend. |
| **Research agent** (PaperQA clone) | Babel has `domain_research` for code investigation. Academic paper research is a different product. |

---

## 6. Effort Summary + Sequencing

### By tier

| Tier | Gaps | Est. days | Cumulative |
|------|------|-----------|------------|
| **T0** | L0 (local backend), L1 (waterfall), L2 (offline mode) | 8–14 | 8–14 |
| **T1** | C1 (IDE), C2 (git), C3 (debug loop), C4 (test gen), C5 (code intel), C6 (caching) | 38–57 | 46–71 |
| **T2** | A1 (browser), A2 (docs), A3 (voice), A4 (triggers), A5 (multi-project) | 32–52 | 78–123 |
| **T3** | E1 (export), E2 (serving), E3 (SDK), E4 (marketplace) | 20–35 | 98–158 |

### Recommended sequence

```
Week 1–2:   L0 → L2  (local inference — existential)
Week 3–4:   C2       (git workflow — highest user-facing impact)
Week 5–7:   C3       (debug loop — directly improves SWE quality)
Week 8–10:  C5       (code intelligence — structural foundation)
Week 11–12: C1       (IDE integration — broadens user surface)
Week 13–14: C4       (test generation — rides on C5 index)
Week 15–16: C6       (local caching — rides on C5 index + L0 local models)
Week 17–20: A1       (browser — biggest adjacent capability)
Week 21–23: A3       (voice — highest UX differentiation)
Week 24–26: A2+A4+A5 (document + automation + multi-project)
Week 27–30: T3       (ecosystem — only after core is solid)
```

**First 4 weeks deliver**: Babel runs offline on local models + commits and opens PRs. This alone would make it a viable preservation target for the #2 category (Coding Agents).

**First 10 weeks deliver**: + autonomous debugging that actually fixes bugs + code intelligence. This would move SWE-A from 2/10 to competitive territory and cover the "individual capabilities" that the ChatGPT framework prizes.

---

## 7. Verification After Each Gap Closes

### L0 — Local inference
```powershell
babel --offline "explain what this repo does"  # must complete with local model
babel --offline "fix the typo in README.md"    # must edit + verify
```

### C2 — Git workflow
```powershell
babel "fix the null check and ship it"
# → agent edits → verifies → commits → pushes → PR URL in output
```

### C3 — Debug loop
```powershell
npm run benchmark:agent:critic -- --all-swe
# → SWE-A correct rate ≥ 5/10
```

### C5 — Code intelligence
```powershell
babel "refactor parseUserInput — find every caller and check compatibility"
# → agent lists all callers from index, edits each, verifies
```

### C1 — IDE integration
```powershell
# In VS Code: Ctrl+Shift+P → Babel: Chat → "fix the null check" → diff in editor
```

### A1 — Browser automation
```powershell
babel "the signup form is broken — find and fix the bug"
# → agent navigates, screenshots error, fixes, re-tests, shows green
```

### A3 — Voice input
```powershell
# Ctrl+Shift+V → speak task → text appears → agent executes
```

---

## 8. Relationship to Existing Roadmap

This audit does NOT replace the existing harness roadmap in `BABEL_CODING_AGENT_STATE_2026-07-08.md`. That document tracks the T0–T5 harness loop work (completion gates, stall detection, BLOCKED, plan-then-execute, diff critic, etc.) — those are mostly done.

This audit adds the **next layer up**: capabilities that sit on top of the now-stable harness loop. Specifically:

- **T0–T5** (from state audit) = the engine runs reliably ✓ (done)
- **Tier 0–3** (this audit) = the engine does everything a coding agent should do

The state audit's remaining work (§5) is T4.2 (TUI follow-ons) and the SWE quality gap. This audit provides the concrete capabilities to close the SWE quality gap (C3 debug loop + C5 code intelligence) and expands into adjacent territory.

---

## 9. Preservation Scorecard (Target State After T0–T1)

If Babel closed Tiers 0–1, here's how it would score against the ChatGPT framework:

| Category | Before | After T0–T1 |
|----------|--------|-------------|
| Coding Agents | 85% | **95%** (+git, +debug, +IDE) |
| Personal Knowledge Systems | 20% | 20% (no change — anti-scope) |
| Local Voice Assistant | 5% | 5% (no change — Tier 2) |
| Automation Agents | 30% | **50%** (+git triggers, +daemon hooks) |
| Browser Agent | 0% | 0% (no change — Tier 2) |
| Research Agent | 25% | **40%** (+code intelligence, +caching) |
| Speech | 5% | 5% (no change — Tier 2) |
| OCR / Document AI | 0% | 0% (no change — anti-scope) |
| Top-10 software coverage | 3/10 | **6/10** (+Cursor via IDE, +Continue, +LM Studio/Ollama) |
| Individual capabilities | 6/10 | **9/10** (+autonomous debugging, +code intelligence, +test generation) |

---

*Audit date: 2026-07-10. Confidence: HIGH on current-state assessment (cross-referenced against source + state audit + competitive comparison). MEDIUM on effort estimates (engineering estimates without implementation proof). Revalidate after each tier closes.*
