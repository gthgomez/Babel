<!--
status: ACTIVE
last_verified: 2026-08-03
-->

# Babel Chat Mode

> **Status:** ACTIVE
> **Role:** Default runtime mode for daily coding work — the conversational coding agent loop.
> **Human entry:** [README.md](../README.md) — quick start and chat-mode showcase.
> **Harness (normative):** [architecture/HARNESS_ARCHITECTURE_V1.md](./architecture/HARNESS_ARCHITECTURE_V1.md).
> **Harness (explanatory):** [architecture/HARNESS_OVERVIEW.md](./architecture/HARNESS_OVERVIEW.md).

## Purpose

Chat mode is the default runtime mode — `babel "<task>"`. It is designed as a lightweight conversational coding agent loop. No v9 orchestrator, no waterfall stages, no QA review gate.

When you type `babel "fix this bug"`, chat mode is what handles it: a multi-turn conversational loop with live tool access, context compaction, and JIT permission approval. It is the path of least resistance for daily coding.

## How It Differs From Plan / Deep

| Aspect | Chat | Plan | Deep | chat-headless |
|--------|------|------|------|---------------|
| Command | `babel "task"` | `babel plan "task"` | `babel deep "task"` | `babel chat-headless "task"` |
| Orchestrator | Not loaded | Not loaded | OLS v9 loaded | Not loaded |
| QA Review | None | Interactive approve/deny | Adversarial reviewer | None |
| Executor | ChatEngine (multi-turn) | Interactive apply / plan profile | CLI Executor (`runExecutorLoop`) | Same ChatEngine (JSON/headless) |
| Pipeline stages | None | Plan path (not full Stage 4 by default) | QA + Stage 4 executor | None |
| Shared kernel | Yes (`executor/kernel`) | Yes (read-only / plan terminal) | Yes (proof-carrying policy) | Yes |
| Completion | Honesty gate + `kernel.completion.decide` | Plan artifact terminal | Gates + verifier contract finalize | Same as chat + **hard** gate (no soft-allow) |
| Use case | Daily coding, read/edit/verify | Design-first, approve to apply | Governed pipeline | CI/testing, scripted automation |

## Chat-Headless

`chat-headless` is the same ChatEngine as chat mode, but with JSON/headless output for CI/scripting. It is a **stable mode alias**, not a second product.

**Preferred long-term form** (product lock 2026-07-12):

```text
babel chat --headless "task"
babel run --mode chat --headless "task"
```

Still supported:

```text
babel chat-headless "task"
babel run --mode chat-headless "task"
```

Under headless/CI, missing authoritative verification hard-blocks after gate strikes (`required` and `strict`) — no soft-allow of `_verify*.py`-only greens.

## What Loads

Chat mode uses a minimal prompt stack to keep context slim and latency low:

1. **`behavioral_core_v11`** — Unified behavioral OS (state model, epistemic discipline, guard rules)
2. **One domain architect** — Selected by task classification (e.g. `domain_swe_backend`, `domain_swe_frontend`)
3. **Domain default skills** — Auto-expanded by the router per the domain's `default_skill_ids`
4. **One model adapter** — Selected by `config/model-policy.json` waterfall (deepseek → qwen3 → scout)

**Not loaded in chat mode:**
- ❌ v9 Orchestrator
- ❌ Pipeline stages (QA reviewer, CLI executor)
- ❌ Meta tools
- ❌ Task overlays (unless explicitly needed)
- ❌ Swarm decomposition

Chat mode's routing is defined in `00_System_Router/OLS-v9-Orchestrator.md` Step G. See the governed pipeline contract there for plan/deep mode details.

## Routing Path

```
babel "task"
  → CLI: argv rewrite → run --mode chat → runCliChatTask (chatCore.ts)
  → REPL: dispatch.ts → executeChatTask (chat.ts) → same runChatEngineOnce
  → ChatEngine (chatEngine.ts) multi-turn loop
       default maxTurns = 200 (safety ceiling; cost/wall/stall budgets usually stop first)
       see chatEngineLimits.ts DEFAULT_CHAT_ENGINE_LIMITS
  → On completion claim:
       evaluateCompletionGate (completionGatePolicy)
       computeTerminalOutcome (chatEngineObservability)
       executorKernel.completion.decide (kernel.ts)  ← final terminal authority
  → TTY: ConversationalRenderer; cost + elapsed footer

babel chat-headless "task"
  → BABEL_HEADLESS=1 / hard gate when non-TTY
  → Same ChatEngine + same completion authority
  → JSON/headless payload (no soft-allow of weak verifier greens under required/strict)
```

### REPL Routing Logic

The REPL dispatch (`babel-cli/src/interactive/execution/dispatch.ts`) routes as follows:

- If mode is `'deep'` → `executeGovernedTask()` — full pipeline
- If mode is `'plan'` → `executePlanTask()` — plan-then-approve
- If mode is `'chat-headless'`:
  - Sets `BABEL_HEADLESS=1`
  - Same routing as `'chat'`: ChatEngine via `executeChatTask()`
  - JSON output, no TUI
- If mode is `'chat'`:
  - If verb is `'deep'` → escalate to governed
  - Otherwise → `executeChatTask()` via ChatEngine

### CLI One-Shot Path

For `babel run "..."` or `babel "..."` (without REPL):

- Default `--mode` is `'chat'` (set in `sharedOptions.ts` line 26)
- Routes to `runCliChatTask()` → same ChatEngine path
- Read-only questions are forced to chat mode

## Escalation Paths

From within chat mode, a user can escalate to governed modes:

| Action | Result |
|--------|--------|
| `babel deep "task"` | Executes governed task (full pipeline) |
| `/mode deep` | Switches REPL to deep mode |
| `babel plan "task"` | Executes plan-then-approve |

## Architecture Reference

Chat mode is defined by the REPL dispatch and ChatEngine. Key source files:

| File | Role |
|------|------|
| `babel-cli/src/cli/constants.ts` | Mode resolution (`LEGACY_MODE_MAP`) |
| `babel-cli/src/cli/sharedOptions.ts` | Default `--mode chat` |
| `babel-cli/src/interactive/BabelRepl.ts` | REPL state init (`mode: 'chat'`) |
| `babel-cli/src/interactive/execution/dispatch.ts` | Routing logic |
| `babel-cli/src/interactive/execution/chat.ts` | REPL bridge (`executeChatTask()`) |
| `babel-cli/src/interactive/execution/chatCore.ts` | Shared engine run (`runChatEngineOnce()`) |
| `babel-cli/src/agent/chatEngine.ts` | Multi-turn agent loop |
| `babel-cli/src/agent/completionGatePolicy.ts` | Write/verifier honesty gates |
| `babel-cli/src/executor/kernel.ts` | Shared completion authority |
| `babel-cli/src/agent/chatEngineObservability.ts` | `computeTerminalOutcome` |
| `babel-cli/src/agent/chatToolDefinitions.ts` | Tool definitions for chat |
| `babel-cli/src/agent/chatApproval.ts` | JIT permission approval |
| `babel-cli/src/config/chatEngineLimits.ts` | Limits (maxTurns=200 default, cost, wall, stall) |

## Completion honesty (harness, not model opinion)

Chat does **not** treat a model “I’m done” answer as success by itself.

1. **Execute tasks** typically need successful **writes** plus policy-dependent verification.
2. Only **authoritative** verifier commands (project test runners, etc.) may green completion — package installs and ad-hoc `_verify*.py` do not.
3. Verifier-dependency **tamper** detection (R9) can block after repeated edits to tracked verifier scripts/`package.json` scripts.
4. Requested `VERIFIED_COMPLETE` can be **downgraded** to `UNVERIFIED_PATCH` by `executorKernel.completion.decide`.
5. Honest outcomes live in `TerminalOutcome` (`agentContracts.ts`); exit 0 only for `VERIFIED_COMPLETE` | `UNVERIFIED_PATCH`.

Details and normative mode/completion rules: [architecture/HARNESS_ARCHITECTURE_V1.md](./architecture/HARNESS_ARCHITECTURE_V1.md).

## Contract

- Chat mode never invokes the v9 orchestrator in the REPL path.
- Chat mode never loads pipeline stages (QA or executor) in the governed pipeline sense.
- The `--use-chat-pipeline` flag exists as a legacy path for `pipeline.ts` but is not the default.
- Chat **does** share the unified executor kernel (completion + tool mapping) with plan/deep — see [architecture/HARNESS_ARCHITECTURE_V1.md](./architecture/HARNESS_ARCHITECTURE_V1.md) and [architecture/ARCHITECTURE.md](./architecture/ARCHITECTURE.md) §Unified Execution Kernel.
- Package-local notes: `babel-cli/CLAUDE.md`, `babel-cli/AGENTS.md`, `babel-cli/PROJECT_CONTEXT.md`. Root `CLAUDE.md` remains repo-wide.
