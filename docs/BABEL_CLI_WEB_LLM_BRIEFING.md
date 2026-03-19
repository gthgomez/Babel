# Babel CLI — Web LLM Briefing

**Purpose of this document:** You are a web-based LLM without direct file access.
This document gives you everything you need to understand, plan for, and reason about
the Babel CLI system. Read it fully before proposing any changes.

---

## 1. What Babel Is

Babel is a **layered prompt operating system** for the wider SaaS workspace
(`GPCGuard`, `Prismatix`, `AuditGuard`). Its job is to assemble the **smallest correct
instruction stack** for a task and route it through the right LLM(s) automatically.

Instead of loading one giant monolithic prompt, Babel stacks discrete layers
(behavioral rules, domain knowledge, model tuning, project context, task guidance)
and compiles them into a single ordered context string before invoking any model.

The CLI is the **live runtime harness** for this system. It lives at `Babel/babel-cli/`.
It is a TypeScript/Node.js application compiled to `babel-cli/dist/` and
invoked as `babel <command>`.

---

## 2. Repository Layout (Babel Root)

```
Babel/
├── BABEL_BIBLE.md               ← Human-facing entrypoint (read this first)
├── PROJECT_CONTEXT.md           ← Canonical system topology and contracts
├── prompt_catalog.yaml          ← Registry of all routable prompt assets
├── 00_System_Router/            ← OLS-v9-Orchestrator.md (default) + OLS-v8 (fallback)
├── 01_Behavioral_OS/            ← Cognitive rules that apply to every agent
├── 02_Domain_Architects/        ← Thin strategy shells (Backend, Frontend, Compliance, …)
├── 02_Skills/                   ← Reusable technical knowledge modules
├── 03_Model_Adapters/           ← Per-model style tuning (Claude, Codex, Gemini)
├── 04_Meta_Tools/               ← Prompt compiler, validator, governance tools
├── 05_Project_Overlays/         ← Thin context files for each SaaS project
├── 06_Task_Overlays/            ← Optional task-specific guidance (frontend polish, etc.)
├── babel-cli/                   ← The runtime CLI (TypeScript source + built dist)
├── runs/                        ← Evidence bundles written at runtime (gitignored)
├── tools/                       ← PowerShell tooling (manifest sync, session lifecycle, …)
└── docs/                        ← Human-facing documentation (including this file)
```

---

## 3. The Prompt Layer Model

Babel compiles a context string from layers loaded in strict order:

| Order | Layer | What it contains |
|-------|-------|-----------------|
| 1 | `01_Behavioral_OS` | How the model must behave (PLAN/ACT gate, evidence rules) |
| 2 | `02_Domain_Architects` | Task strategy, invariants, default skill bundles for the domain |
| 3 | `02_Skills` | Reusable technical knowledge (expanded from domain defaults or explicit selection) |
| 4 | `03_Model_Adapters` | Style and execution shape tuning for the specific model |
| 5 | `05_Project_Overlays` | Repository-specific constraints (hard invariants for GPCGuard, etc.) |
| 6 | `06_Task_Overlays` | Optional bounded guidance (frontend professionalism, launch readiness, etc.) |
| 7 | Pipeline stage prompt | The specific stage's instructions (orchestrator, SWE agent, QA, executor) |
| — | Task context | The user's raw task string — always injected last |

Each layer is wrapped in file boundary markers:

```
--- START OF FILE: SomeLayer.md ---
<content>
--- END OF FILE: SomeLayer.md ---
```

The task is injected after all layers:

```
--- TASK CONTEXT ---
<user task string>
```

**Why last?** Recency bias — the model reads instructions first, then the task.

---

## 4. The Prompt Catalog (`prompt_catalog.yaml`)

`prompt_catalog.yaml` is the **single source of truth** for every routable prompt file.
Each entry contains:

- `id` — unique identifier used by the orchestrator and compiler
- `layer` — which layer it belongs to (`behavioral_os`, `domain_architect`, `skill`, etc.)
- `path` — file path relative to the Babel root
- `status` — `active` or inactive (non-active entries are rejected by the resolver)
- `load_position` — tiebreaker within the same layer
- `token_budget` — estimated token cost (used by the budget policy checker)
- `dependencies` — other skill IDs that must load before this one
- `conflicts` — IDs that must NOT be loaded alongside this one
- `default_skill_ids` — skills a domain architect auto-includes

**Rule:** Do not invent prompt files that are not listed in `prompt_catalog.yaml`.
If a file is referenced but missing on disk, it is treated as a system integrity error.

---

## 5. The Four-Stage Pipeline

Every `babel run <task>` call goes through these four stages in sequence:

```
User task
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Stage 1 — Orchestrator                              │
│ Model: STRUCTURAL waterfall (Groq → OpenAI → Claude)│
│ Input:  raw task string                             │
│ Output: OrchestratorManifest (JSON)                 │
│   ├─ prompt_manifest: ordered list of file paths   │
│   ├─ domain, target_model, project                 │
│   ├─ (v9) instruction_stack + resolution_policy    │
│   └─ (v9) compiled_artifacts after resolver runs  │
└─────────────────────────────────────────────────────┘
    │
    ▼ Compiler runs: loads files from manifest, concatenates layers, appends task
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Stage 2 — SWE Agent                                │
│ Model: REASONING waterfall (Codex → Claude →       │
│         Gemini → Groq)                             │
│ Input:  compiled prompt string                     │
│ Output: SwePlan (JSON)                             │
│   ├─ minimal_action_set: list of tool calls        │
│   ├─ reasoning_trace                               │
│   └─ confidence                                    │
└─────────────────────────────────────────────────────┘
    │
    ▼ QA loop: up to 3 attempts
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Stage 3 — QA Reviewer                              │
│ Model: STRUCTURAL waterfall                        │
│ Input:  SwePlan from Stage 2                       │
│ Output: QaVerdict (JSON)                           │
│   ├─ verdict: "PASS" or "REJECT"                   │
│   └─ rejection_tags (if REJECT)                    │
│ Loop: REJECT → re-run Stage 2, up to 3× total     │
│ Stage 4 is BLOCKED unless latest verdict is PASS  │
└─────────────────────────────────────────────────────┘
    │
    ▼ Only if QA verdict = PASS
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Stage 4 — CLI Executor                             │
│ Model: STRUCTURAL waterfall                        │
│ Input:  approved SwePlan                           │
│ Output: ExecutionReport                            │
│   Multi-turn loop: emit tool call → execute tool  │
│   → append result to history → next turn          │
│   History is accumulated as a string and          │
│   prepended to each new prompt turn               │
└─────────────────────────────────────────────────────┘
    │
    ▼
Evidence bundle written to runs/<slug>-<timestamp>/
```

---

## 6. The Dual Waterfall Executor

Two waterfall strategies exist, selected per stage:

### STRUCTURAL waterfall (Stages 1, 3, 4)
Optimised for fast, reliable JSON generation.

```
Tier 1 → Groq API       (Llama 3.3 70B — ultra-fast, cheapest)
Tier 2 → OpenAI API     (o3-mini — strong reasoning backup)
Tier 3 → Claude CLI     (high-judgment, guaranteed quality)
```

Always starts at Tier 1 (Groq). `targetModel` is ignored in structural mode.

### REASONING waterfall (Stage 2 only)
Optimised for heavy SWE reasoning. Starting tier is set by `targetModel`.

```
Tier 1 → Codex CLI      (coding agent — starts here by default)
Tier 2 → Claude CLI     (high-judgment refactoring, compliance)
Tier 3 → Gemini CLI     (long-context analysis, document synthesis)
Tier 4 → Groq API       (ultra-cheap fallback)
```

### Cascade Rules

| Condition | Action |
|-----------|--------|
| Binary not found (ENOENT) | Cascade immediately, no retry |
| Rate limit / quota (429) | Cascade immediately, no retry |
| JSON / Zod parse failure | Retry up to `maxCliAttempts` (default 2), then cascade |
| Spawn timeout / non-zero exit | Same as parse failure |
| Runner construction error (missing API key) | Cascade immediately |
| `BABEL_DISABLE_API_FALLBACK=true` | Throw instead of using any API tier |

If all tiers in a waterfall fail, the pipeline throws and halts.

---

## 7. v9 vs v8 Orchestrator

### v8 (Compatibility fallback)
Returns a flat `OrchestratorManifest` with a direct `prompt_manifest` array of file paths.
Still supported. Downstream worker/QA/executor stages consume it unchanged.

### v9 (Default runtime lane)
Returns a typed `OrchestratorManifest` that additionally contains:

- `instruction_stack` — typed intent: `behavioral_ids`, `domain_id`, `skill_ids`,
  `model_adapter_id`, `project_overlay_id`, `task_overlay_ids`, `pipeline_stage_ids`
- `resolution_policy` — flags controlling skill expansion, dependency resolution,
  conflict checking
- `compiled_artifacts` — the result of the compiler/resolver running against
  `prompt_catalog.yaml`:
  - `selected_entry_ids` — which catalog IDs were selected
  - `prompt_manifest` — resolved ordered file paths (mirrors root `prompt_manifest`)
  - `token_budget_total`, `token_budget_by_entry` — budget accounting
  - `budget_diagnostics` — warn/severe flags if budget thresholds are crossed

The compiler validates:
- Every ID exists in `prompt_catalog.yaml` and has status `active`
- Every resolved path exists on disk
- No conflicts between selected entries
- Skill dependency cycles are detected and rejected

If a v9 manifest is already compiled (`compilation_state: "compiled"`), the resolver
is skipped — no double compilation.

---

## 8. CLI Commands

### `babel run <task>`

Full pipeline: Stages 1 → 2 → 3 → 4.

```
Options:
  --project <name>     Target project (GPCGuard | Prismatix | AuditGuard)
  --model   <model>    Starting model for Stage 2 (Codex | Claude | Gemini)
  --mode    <mode>     "auto" (default) or "manual" (pauses after Stage 3 for review)
  --dry-run            Override BABEL_DRY_RUN — Stage 4 tools are mocked
```

In **auto mode**, all four stages run unattended.
In **manual mode**, the pipeline pauses after QA approval and writes a `plan.json` to
`runs/<slug>/` for human review before the executor runs.

### `babel plan <project> <intent...>`

Alias for `babel run --mode manual --project <project> <intent>`.
Produces a `plan.json` in a new run directory. No execution happens.

### `babel resume` / `babel apply`

Resumes a manual bridge run. Reads an approved `plan.json` and runs Stage 4 only.

```
Options:
  --run <run_dir>      Path to an existing run directory
  --project <name>     Use the latest run pointer for this project
  --plan <path>        Path to plan.json, "-" for stdin, or "clipboard"
```

### `babel smoke` / `babel test`

Runs the manual bridge smoke suite. Exercises the executor against staged plans and
summarises outcomes (pass/fail/dry-run) across a set of test scenarios.

```
Options:
  --project <name>     Filter to a specific project
```

---

## 9. Tools Available to Stage 4 (CLI Executor)

The executor emits JSON tool call requests. Each tool has a Zod schema enforced before
execution. Tools run against `SafeExecutor` (sandbox) when live.

| Tool | Always live? | Dry-run behaviour | Description |
|------|-------------|-------------------|-------------|
| `file_read` | Yes | N/A | Read a file within project root |
| `file_write` | No | Logs intent, returns synthetic success | Write a file within project root |
| `shell_exec` | No | Logs intent, returns synthetic success | Run a whitelisted shell command |
| `test_run` | No | Logs intent, returns synthetic success | Run tests (whitelisted commands, longer timeout) |
| `mcp_request` | Yes | N/A | Send a JSON-RPC 2.0 request to a configured MCP server |
| `audit_ui` | No | Logs intent | Spawn the AuditGuard orchestrator against a URL |
| `memory_store` | Yes* | Logs in dry-run | Write a fact to Chronicle (SQLite) |
| `memory_query` | Yes | N/A | Read a fact from Chronicle (SQLite) |

*`memory_store` is always live because writes are idempotent; dry-run still mocks it.

**Dry-run mode** is the default (`BABEL_DRY_RUN !== 'false'`). Set `BABEL_DRY_RUN=false`
to enable live execution. Validate dry-run output before going live.

### Sandbox Protections (live mode only)

1. **Path traversal prevention** — all file paths are resolved to absolute and verified
   to be within `BABEL_PROJECT_ROOT` before any I/O.
2. **Command whitelist** — `shell_exec` and `test_run` only accept:
   `npm`, `npx`, `node`, `git`, `python`, `python3`, `py`, `pytest`, `pip`, `pip3`
3. **Shell injection blocking** — any command string containing `;|&><\`$(){}!\` is
   rejected before spawning.
4. **`shell: false`** — `spawnSync` never uses a shell interpreter. On Windows,
   `cmd.exe` is invoked directly to resolve `.cmd` shims.
5. **Secret stripping** — `GEMINI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY` are removed from `process.env` before passing it to `spawnSync`.

---

## 10. Chronicle Persistent Memory

The executor has access to a SQLite database (`babel-cli/chronicle.sqlite`) through the
`memory_store` and `memory_query` tools.

- **Schema:** `babel_facts(project_root, fact_key, fact_value, last_verified)`
- `memory_store` writes or overwrites a fact keyed by `(project_root, fact_key)`.
- `memory_query` reads a single fact or all facts (`key = "ALL"`) for the current project root.
- A cache miss returns `exit_code: 0` with empty `stdout` — it is not treated as an error.
- The DB is scoped to `BABEL_PROJECT_ROOT` (defaults to `process.cwd()`).

---

## 11. Evidence Bundles

Every pipeline run writes an evidence bundle to `runs/<slug>-<timestamp>/`:

```
runs/<slug>-<timestamp>/
├── manifest.json          ← OrchestratorManifest
├── compiled_prompt.txt    ← Full compiled context string sent to Stage 2
├── swe_plan.json          ← Stage 2 output
├── qa_verdict.json        ← Stage 3 output
├── execution_report.json  ← Stage 4 output
├── debug_cli_raw_stdout.log  (written on parse failure)
└── debug_zod_error.json      (written on Zod failure)
```

The `runs/` directory is gitignored. Evidence bundles are the canonical record of
what happened during a run.

---

## 12. Local Mode Session Discipline

When using Babel through a local/editor surface, raw evidence bundles alone are
**non-canonical**. A valid Local Mode run requires full lifecycle artifacts:

```
runs/local-learning/session-starts/<UTC-date>/   ← written by start-local-session.ps1
runs/local-learning/session-ends/<UTC-date>/     ← written by end-local-session.ps1
runs/local-learning/session-log.jsonl            ← append-only session log
```

**Lifecycle scripts:**

| Script | Purpose |
|--------|---------|
| `tools/launch-babel-local.ps1` | Primary start — prints required `BABEL_SESSION_*` env vars |
| `tools/start-local-session.ps1` | Alternative start |
| `tools/end-local-session.ps1` | Close session; must be called after work |
| `tools/report-run-consistency.ps1` | Audit raw bundles vs lifecycle logs for drift |
| `tools/reconcile-pending-sessions.ps1` | Detect timed-out/incomplete sessions; writes to `protocol-violations.jsonl` |

When `babel run` is called in a local session, the env vars `BABEL_SESSION_ID`,
`BABEL_SESSION_START_PATH`, and `BABEL_LOCAL_LEARNING_ROOT` must be set
(printed by `launch-babel-local.ps1`). Without them, the run is logged as
protocol-incomplete.

**Stage 4 execution gate:** Stage 4 is blocked unless the latest QA verdict is `PASS`.
It cannot be bypassed even in resume/manual flows.

---

## 13. LLM Runner Implementations

| Runner | File | Protocol | Notes |
|--------|------|----------|-------|
| `GroqApiRunner` | `runners/groqApi.ts` | Groq SDK | Default structural tier 1 |
| `OpenAiApiRunner` | `runners/openAiApi.ts` | OpenAI SDK | Structural tier 2 |
| `ClaudeCliRunner` | `runners/claudeCli.ts` | Spawns Claude CLI, reads stdout | Structural tier 3 / reasoning tier 2 |
| `CodexCliRunner` | `runners/codexCli.ts` | Writes prompt to temp file, spawns Codex | Reasoning tier 1; Windows workaround via temp file |
| `GeminiCliRunner` | `runners/geminiCli.ts` | Spawns Gemini CLI, pipes prompt via stdin | Reasoning tier 3 |
| `GeminiApiRunner` | `runners/geminiApi.ts` | fetch → REST API, key in `x-goog-api-key` header | Repair/fallback runner in structuredRunner.ts |
| `StructuredRunner` | `runners/structuredRunner.ts` | Wraps CLI runners | Adds JSON extraction + Zod retry logic to CLI runners |

All runners implement `LlmRunner`:
```typescript
interface LlmRunner {
  execute<T>(prompt: string, schema: ZodSchema<T>): Promise<T>;
}
```

---

## 14. Environment Variables Reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Required for GeminiApiRunner |
| `GROQ_API_KEY` | — | Required for GroqApiRunner |
| `ANTHROPIC_API_KEY` | — | Required for ApiFallbackRunner (Claude API) |
| `OPENAI_API_KEY` | — | Required for OpenAiApiRunner |
| `BABEL_ROOT` | Two dirs above `pipeline.ts` | Root of the Babel prompt layer tree |
| `BABEL_PROJECT_ROOT` | `process.cwd()` | Target project root for SafeExecutor and Chronicle |
| `BABEL_DRY_RUN` | `"true"` | Set to `"false"` to enable live Stage 4 execution |
| `BABEL_DISABLE_API_FALLBACK` | unset | Set to `"true"` to throw instead of using API tiers |
| `BABEL_GROQ_MODEL` | `"llama-3.3-70b-versatile"` | Groq model ID |
| `BABEL_GROQ_TOKENS` | `8096` | Groq max output tokens |
| `BABEL_GEMINI_MODEL` | `"gemini-2.5-flash-lite"` | Gemini API model ID |
| `BABEL_GEMINI_TOKENS` | `8192` | Gemini API max output tokens |
| `BABEL_SESSION_ID` | — | Local Mode session identifier |
| `BABEL_SESSION_START_PATH` | — | Local Mode session start path |
| `BABEL_LOCAL_LEARNING_ROOT` | — | Local Mode learning root directory |

---

## 15. Key Contracts — Do Not Break

1. **`OLS-v9-Orchestrator.md` JSON contract** — Stage 1 output schema. The compiler
   and all downstream stages depend on it. Breaking the schema halts the entire pipeline.

2. **`OLS-v8-Orchestrator.md` JSON contract** — v8 is a live compatibility fallback.
   It must continue to produce a valid `OrchestratorManifest`.

3. **`prompt_catalog.yaml` registry contract** — Every prompt file used at runtime
   must be registered here. Any catalog change affects all runs that reference those IDs.

4. **`01_Behavioral_OS` behavioral contract** — These rules apply to all agents.
   Changes propagate globally across every pipeline stage and every project.

5. **Stage 4 QA gate** — Stage 4 will not execute unless the latest QA verdict is
   `PASS`. This is enforced in `pipeline.ts` and cannot be bypassed.

6. **`BABEL_DRY_RUN` default** — Dry-run is ON by default. Mutating tools do nothing
   unless `BABEL_DRY_RUN=false` is explicitly set.

---

## 16. What to Ask For / Upload in a Web LLM Session

If you need to work on a specific part of the system, request these files:

| Task | Files to upload |
|------|----------------|
| Change pipeline logic | `babel-cli/src/pipeline.ts`, `babel-cli/src/schemas/agentContracts.ts` |
| Change prompt compilation | `babel-cli/src/compiler.ts`, `prompt_catalog.yaml` |
| Change waterfall routing | `babel-cli/src/execute.ts` |
| Change tool execution | `babel-cli/src/localTools.ts`, `babel-cli/src/sandbox.ts` |
| Change orchestrator behavior | `00_System_Router/OLS-v9-Orchestrator.md` (and/or v8) |
| Add a new domain architect | `02_Domain_Architects/<new>.md`, update `prompt_catalog.yaml` |
| Add a new skill | `02_Skills/<new>.md`, update `prompt_catalog.yaml` |
| Add a new task overlay | `06_Task_Overlays/<new>.md`, update `prompt_catalog.yaml` |
| Change CLI commands | `babel-cli/src/index.ts` |
| Change Local Mode lifecycle | `tools/launch-babel-local.ps1`, `tools/start-local-session.ps1`, `tools/end-local-session.ps1` |

Always include `PROJECT_CONTEXT.md` and `BABEL_BIBLE.md` with any upload.

---

## 17. Non-Negotiable Rules

- Do not invent prompt file IDs that are not in `prompt_catalog.yaml`.
- Do not load more layers than necessary — assemble the smallest correct stack.
- Do not let task/style overlays override behavioral OS rules or project invariants.
- Do not bypass the Stage 4 QA gate — a `REJECT` verdict must block execution.
- Do not use `shell: true` in `spawnSync` calls — always use `shell: false`.
- Do not expose API keys in URLs — keys belong in headers or the SDK constructor.
- Do not remove the path traversal check in `sandbox.ts`.
- Do not remove the command whitelist in `sandbox.ts`.
- After any significant pipeline run, update `PROJECT_CONTEXT.md` if system topology changed.

---

*Generated: 2026-03-18 | Source: babel-cli source audit + BABEL_BIBLE.md + PROJECT_CONTEXT.md*
