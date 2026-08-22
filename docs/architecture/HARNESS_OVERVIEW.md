<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
-->

<!--
status: ACTIVE
last_verified: 2026-08-04
architecture_version: harness-v1
authority: explanatory
-->

# Babel Harness Overview

> **This document is explanatory.** The **normative** authority is [`HARNESS_ARCHITECTURE_V1.md`](./HARNESS_ARCHITECTURE_V1.md) (`harness-v1`).  
> Do **not** treat this overview as a competing specification. When prose conflicts, the normative file wins.

> **Role**: Short readable map of how the **runtime harness** works — not the Prompt OS layer catalog alone.  
> **Audience**: Future agents and maintainers who need orientation before deep dives.  
> **Companions**: [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) (normative), [ARCHITECTURE.md](./ARCHITECTURE.md) (Prompt OS), [CHAT_MODE.md](../CHAT_MODE.md), [ADR-012](../adr/ADR-012-canonical-harness-architecture-v1.md).

## One equation

```text
Agent = Model + Harness
```

| Piece | What it owns | What it does *not* own |
|-------|----------------|------------------------|
| **Model** | Proposals: plan text, tool calls, “I’m done” answers | Final terminal outcome, policy, isolation |
| **Harness** | Tools, permissions, sandbox, mutation safety, completion honesty, evidence, budgets, mode policy | Repo truth, flaky tests, provider uptime |
| **Environment** | Filesystem, Git, deps, OS, Docker daemon, test oracles | Product routing decisions |

**Deployable success is multiplicative.** A strong model against stale context, a weak verifier, or host fallback without isolation still fails. Public docs correctly claim implemented surfaces without claiming production readiness.

### Closed loop (target shape)

```text
Discover → Reproduce → Freeze task/acceptance → Plan
  → Bounded execute → Verify (protected oracles) → Classify
     ├─ Pass → independent final check (when wired)
     ├─ Implementation failure → repair budget
     ├─ Infrastructure failure → infra retry (separate budget)
     ├─ Already fixed / invalid → NO_CHANGE / INVALID (not force-edit)
     └─ Policy → block or escalate
```

Babel implements most of this as **controller gates** around the model, not as model self-report.

---

## Two product engines, one shared substrate

| Engine | When | Controller | Stack compiler |
|--------|------|------------|----------------|
| **ChatEngine** (daily) | `babel "task"`, `babel chat`, `chat-headless` | Multi-turn agent loop | Slim `compileChatStack` |
| **Governed pipeline** | `babel deep`, `babel plan` (pipeline), `babel run --mode deep` | V9 stages 1–4 | Catalog `stackResolver` + `compileContext` |

Both use:

- `babel-cli/src/executor/kernel.ts` — completion authority + mode policy
- `babel-cli/src/executor/contracts.ts` — effect classes, mode policies, event shapes
- `babel-cli/src/agent/canonicalToolMapping.ts` — model tool names ↔ executor names
- `babel-cli/src/agent/toolExecutor.ts` / `sandbox.ts` — policy + shell isolation path

They do **not** share control loops. Chat is not “deep without QA”; deep is not “ChatEngine with more prompts.”

```text
                    ┌─────────────────────────────┐
                    │   createExecutorKernel(mode) │
                    │   completion.decide · tools  │
                    └─────────────┬───────────────┘
           ┌──────────────────────┼──────────────────────┐
           ▼                      ▼                      ▼
    ChatEngine loop        plan read-only          pipeline Stage 4
    (daily coding)         plan artifact           runExecutorLoop
```

---

## Mode parity matrix

| Dimension | **chat** | **chat-headless** | **plan** | **deep** |
|-----------|----------|-------------------|----------|----------|
| Entry | `babel "task"` / `babel chat` | `babel chat-headless` or `babel chat --headless` | `babel plan "task"` | `babel deep "task"` |
| Engine | ChatEngine | Same ChatEngine | Plan lane / plan profile | V9 pipeline → Stage 4 executor |
| V9 orchestrator | No | No | Partial / plan path | Yes |
| QA reviewer stage | No | No | Interactive / plan gates | Yes (SWE↔QA loop) |
| Mutation policy | `normal` | `normal` | `read_only` | `governed` |
| Approval | Interactive / JIT | Headless policy | Handoff required | Stage-gated |
| Completion policy | `executor` | `executor` (harder gate) | `plan_artifact` | `proof_carrying` |
| Verification | Task-class: `none` \| `required` \| `strict` | Same + **hard-block** after gate strikes | Plan complete ≠ verified patch | Required-verifier contract at finalize |
| Stack | Slim chat stack | Same | Plan / catalog | Full catalog resolve |
| Shared kernel | Yes | Yes | Yes | Yes |

**Naming collision to avoid:** product “Full orchestration / Spark deep proof” wording in [BABEL_FULL_ORCHESTRATION.md](./BABEL_FULL_ORCHESTRATION.md) can describe a **read-only multi-agent proof lane**. Pipeline mode `deep` in `pipeline.ts` **does execute Stage 4 mutations** when gates pass. Treat those as related but not identical surfaces.

**Lite / AgentSession:** historical Lite docs still mention `AgentSession`. The **canonical daily path** for current CLI is ChatEngine via `workflowCommands` → `runCliChatTask` / REPL `executeChatTask`. Prefer ChatEngine when reading code.

---

## Call graphs

### Daily: `babel "task"`

```text
argv rewrite → run --mode chat
  → workflowCommands useChatEnginePath
  → runCliChatTask / runChatEngineOnce          (chatCore.ts)
       → compileChatStackForRun + intent compile
       → ChatEngine.submitMessageStream
            for turn in 0..maxTurns:
              budgets · compaction · LLM
              tools → policy → sandbox → receipts
              completion claim → honesty gate → critic
            streamDone:
              computeTerminalOutcome
              executorKernel.completion.decide   ← final authority
       → TerminalOutcome → exit / JSON / TUI
```

### Headless / CI

Same engine. Differences:

- `BABEL_HEADLESS=1` / non-TTY → **hard** completion gate (no soft-allow of weak greens)
- Presentation: JSON payload via `buildChatRunPayload`, not conversational TUI

### Governed: `babel deep "task"`

```text
executeGovernedTask / runBabelPipeline
  → Stage 1 Orchestrator (OLS-v9) → instruction_stack
  → stackResolver + compileContext
  → Stage 2 SWE plan
  → Stage 3 QA PASS|REJECT (≤3 loops) + deterministic gates
  → Stage 4 runExecutorLoop (only if deep + approved)
       → worktree safety · tool policy · repair
  → finalize: required-verifier contract demotion if unsatisfied
  → EvidenceBundle under runs/
```

---

## Authority boundaries (who owns the truth)

| Fact | Required owner | Primary code |
|------|----------------|--------------|
| User intent / task text | Frozen at run start (envelope / options) | `taskEnvelope.ts`, CLI options |
| Allowed tools / paths | Envelope + profile + policy | `taskEnvelope`, `executionProfiles`, `toolExecutor` |
| Tool effect class | Harness taxonomy | `executor/contracts.ts` `classifyToolEffect` |
| File-change truth | Filesystem + pre/post hashes | `workspaceTransactions`, `worktreeSafety` |
| Test / verifier result | Independent command execution + receipts | Shell/`test_run` + `completionGatePolicy` |
| Mid-loop “may I finish?” | Honesty gate | `evaluateExecuteCompletionHonesty` |
| Final terminal enum | **Executor kernel** (not model) | `kernel.ts` `decideCompletion` |
| Pipeline COMPLETE demotion | Verifier contract reconcile | `requiredVerifierContract`, `pipeline/finalization` |
| Benchmark `false_complete` | Scoring harness (not live CLI label) | `agentBenchmarkHarness` |
| Cost / wall / tokens | Budget controllers | `budgetKillPolicy`, `chatEngineLimits` |
| Human approval | Approval ledger / interactive ask | `chatApproval`, approval profiles |

### Completion one-liner

> The **model proposes** completion; **ChatEngine** enforces process (stall, budgets, critic); **completionGatePolicy** judges write + authoritative verifier evidence; **`executorKernel.completion.decide`** sets the final `TerminalOutcome` (including downgrading false greens).

### Honest terminal outcomes (`TerminalOutcome`)

Defined in `babel-cli/src/schemas/agentContracts.ts`:

| Outcome | Meaning |
|---------|---------|
| `VERIFIED_COMPLETE` | Done + green **authoritative** verifier |
| `UNVERIFIED_PATCH` | Done without green authoritative verifier (includes downgraded claims) |
| `BLOCKED_EXTERNAL` | Env / toolchain / external blocker |
| `BLOCKED_POLICY` | Gate, critic, stall, zero-write, tamper, progress kill |
| `BUDGET_EXHAUSTED` | Wall, cost, or token budget |
| `CANCELLED` | User cancel |
| `INFRA_FAILURE` | Provider / infrastructure |
| `AGENT_FAILURE` | Agent crash / unrecoverable logic |

Passing outcomes for exit code 0: `VERIFIED_COMPLETE` | `UNVERIFIED_PATCH` only.

Do not treat `ChatResult.status === 'completed'` as verified success.

---

## Verifier systems (three layers — do not collapse them)

| Layer | Role | Code |
|-------|------|------|
| **Chat honesty gate** | Blocks mid-session “I’m done” without writes + authoritative green | `completionGatePolicy.ts`, ChatEngine |
| **Shared completion authority** | Accept / downgrade `VERIFIED_COMPLETE` | `executor/kernel.ts` |
| **Pipeline required-verifier contract** | Post-run plan vs tool log; demotes COMPLETE | `requiredVerifierContract.ts` |

Additional (partially wired):

| Layer | Status |
|-------|--------|
| R9 verifier-dependency integrity | **Detect + escalate** (hash scripts/files; tamper strikes) — `verifierIntegrity.ts` |
| Chat revision-bound receipts + evidence graph on proof | **Live Chat path** — `chatRevisionBinding.ts`, `evaluateEvidenceSync` |
| `IndependentVerifier` tree-copy | **Env opt-in** or **high-assurance profile default** (`benchmark_container`, `babel_research`, and the workspace-manager profile); everyday `safe_repo` still off |
| Benchmark overlay / gold | External fail-to-pass scoring; labels `false_complete`, `incorrect_patch`, `verifier_tampered` |

### Authoritative vs likely commands

- `isLikelyVerifierCommand` — logging / counters (broader)
- `isAuthoritativeVerifierCommand` — may green completion (allowlist prefixes; package installs **never** green)
- Structural identity (`verifierIdentity.ts`) enforces full vs targeted in pipeline **and** Chat honesty (`verifier_scope`). IndependentVerifier clean-room: `BABEL_INDEPENDENT_VERIFIER` env **or** profile `independentVerifierDefault`.

### Evidence is multi-stream (today)

Chat may write `thread_events.json`, `session-events.jsonl`, and hash-linked `episode-events.jsonl` (`episodeStream.ts`, dual-write from parity flush). The pipeline writes the authoritative `EvidenceBundle` plus one validated, hash-linked `PipelineEpisodeSink` stream per primary or manual run; persistence is observable as `active` or `degraded`. Phase instrumentation, offline integration, cross-mode replay consumers, and TUI replay remain release-gate work.
---

## Isolation and mutation safety (summary)

| Mechanism | Strength | Notes |
|-----------|----------|-------|
| Docker sandbox (`safe_repo` default) | Strong when active | `--network none`, cap-drop, no-new-privileges |
| Host fallback | Controlled | Isolation profiles fail-close without Docker; escalate with `BABEL_ALLOW_HOST_FALLBACK=1` (H13) |
| Child env allowlist | Strong | `getSafeEnv()` strips secrets by default |
| File mutation batch | Strong for writes | Pre/post hashes, undo batch (`workspaceTransactions`) |
| Worktree dirty veto | Strong on deep loop | Refuse overwrite of dirty/protected paths; rollback backups |
| Interpreter allowlist | Partial | Blocks inline `-e`/`-c` by default; **script files still run** |

---

## Prompt OS vs runtime harness

| Concern | Where to read |
|---------|----------------|
| Six layers, catalog, precedence | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| V9 routing manifest | `00_System_Router/OLS-v9-Orchestrator.md`, `prompt_catalog.yaml` |
| Chat stack contents | [CHAT_MODE.md](../CHAT_MODE.md), `chatStackCompile.ts` |
| How the agent **runs** | **This file** + source map below |

Behavioral OS / domain / skills **guide** the model (feedforward). Security-sensitive behavior must remain **enforced** outside the model (sandbox, gates, kernel).

---

## Source map for future agents

Read in this order when changing harness behavior:

| Priority | Path | Why |
|----------|------|-----|
| 1 | `babel-cli/src/agent/chatEngine.ts` | Daily loop, gates, budgets, streamDone |
| 2 | `babel-cli/src/agent/completionGatePolicy.ts` | Write/verifier honesty |
| 3 | `babel-cli/src/executor/kernel.ts` | Shared completion authority |
| 4 | `babel-cli/src/executor/contracts.ts` | Mode policy, effect classes, events |
| 5 | `babel-cli/src/interactive/execution/chatCore.ts` | CLI/REPL → engine entry |
| 6 | `babel-cli/src/agent/chatEngineObservability.ts` | `computeTerminalOutcome` |
| 7 | `babel-cli/src/pipeline.ts` | Governed state machine |
| 8 | `babel-cli/src/pipeline/executorLoop.ts` | Deep Stage 4 |
| 9 | `babel-cli/src/sandbox.ts` + `config/executionProfiles.ts` | Isolation profiles |
| 10 | `babel-cli/src/services/worktreeSafety.ts` | Dirty veto / rollback |
| 11 | `babel-cli/src/services/requiredVerifierContract.ts` + `verifierIdentity.ts` | Pipeline verifier plan + structural identity |
| 12 | `babel-cli/src/schemas/agentContracts.ts` | Zod contracts + `TerminalOutcome` |
| 13 | `babel-cli/src/evidence/episodeStream.ts` + `pipeline/pipelineEpisodeSink.ts` + `chatEngineParityBridge.ts` | Chat + pipeline episode producers |
| 14 | `babel-cli/src/evidence/independentVerifier.ts` | Clean-room IV env + profile defaults |

**Do not** treat `sessionLoop.ts` as the ChatEngine turn machine — it is read-only lane step payloads.

---

## Known gaps (honest, code-backed)

Use these when planning reliability work; do not paper over them in marketing claims.

1. **Docker isolation is conditional** — missing Docker/image on isolation profiles **fail-closes** unless `BABEL_ALLOW_HOST_FALLBACK=1` or `BABEL_DOCKER_DISABLE=true` (H13). Operator UX: see [CHAT_MODE.md](../CHAT_MODE.md) (use `dev_local` for host-only day-to-day).
2. **Verifier independence** — revision bind + honesty scope live; clean-room IndependentVerifier is env **or** high-assurance profile default — **not** everyday `safe_repo` Chat finalize.
3. **Required-command scope is live** in pipeline + Chat honesty; residual is product UX (discoverability of full-suite requirements).
4. **Evidence multi-stream** — Chat and pipeline both produce validated `episode-events.jsonl` alongside EvidenceBundle/session evidence; EvidenceBundle remains authoritative on degradation; cross-mode replay is incomplete.
5. **`ModeController` interface** exists; production chat is still ChatEngine + `kernel.decide`, not a full adapter implementation for every mode.
6. **Chat revision binding + evidence-graph proof are live**.
7. **Doc history**: Lite `AgentSession` vs ChatEngine, and Full RO proof vs pipeline deep mutation — always check this overview + code over older Lite wording.

---

## Reference architecture checklist (audit lens)

From reliability research (Anthropic/OpenAI/SWE-bench-style harness engineering), score each subsystem independently so a strong Prompt OS cannot hide a weak verifier:

1. Task contract  
2. Context / instruction compiler  
3. Risk router and controller  
4. Typed capability broker  
5. Isolated execution environment  
6. Transactional workspace  
7. Independent verifier kernel  
8. Failure classification and repair  
9. Evidence and replay protocol  
10. Evaluation and promotion system  
11. Operator / CLI experience  

Maturity for public Babel is **architecturally advanced pre-1.0** on several dimensions (stack compile, completion honesty, worktree safety, evidence artifacts) and **not yet independently proven** on universal isolation, clean-room verification, and single-episode replay. Re-audit against code; do not treat any score as a live SLA.

---

## Related docs

| Doc | Use |
|-----|-----|
| [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) | **Normative** harness specification |
| [ADR-012](../adr/ADR-012-canonical-harness-architecture-v1.md) | Decision record |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, catalog, V9 pipeline overview |
| [CHAT_MODE.md](../CHAT_MODE.md) | Chat product path |
| [BABEL_LOCAL_MODE.md](./BABEL_LOCAL_MODE.md) | Surfaces and sessions |
| [BABEL_FULL_ORCHESTRATION.md](./BABEL_FULL_ORCHESTRATION.md) | Full/Spark product lane |
| [operator-status-taxonomy.md](./operator-status-taxonomy.md) | Doctor / env codes (not full runtime failure model) |
| ADRs 001–004, 006–008 | Pipeline + isolation decisions |
| `examples/golden-harness/` | Golden + negative fixtures |
| `babel-cli/README.md` | Evidence limits and package honesty |
