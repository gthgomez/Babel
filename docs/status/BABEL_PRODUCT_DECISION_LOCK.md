# Babel Product Decision Lock — v2 (Coding Agent Identity)

<!--
status: ACTIVE
last_verified: 2026-07-12
-->

Date: 2026-07-05 (Ollama experimental lock: 2026-07-12)

## History

This document replaces the v1 lock (2026-06-05), which set a 30–45 day identity
freeze during the CLI consolidation and chat-mode routing rewrite. That period
has concluded. The v1 lock's core insight — that Babel was a "Prompt OS companion
CLI" — has been superseded by evidence: chat mode (the default surface) behaves
as a conversational coding agent in practice, while the governed pipeline is an
optional deeper mode, not the product's primary identity.

## Decision

Babel's product identity is now:

> **Babel is a conversational Coding Agent for your terminal, with an optional
> governed pipeline mode (Prompt OS) for high-stakes work.** The two can be used
> independently — daily tasks run through the lightweight chat loop; plan and deep
> modes compile the full prompt stack for governed, reviewable execution.

Key distinctions this identity clarifies:

| Aspect | Coding Agent (chat mode) | Prompt OS mode (deep/plan) |
|--------|--------------------------|---------------------------|
| Default? | Yes — `babel "<task>"` | No — opt-in via `babel deep` |
| Pipeline | No orchestrator | Full v9 stack: orchestrate → plan → review → execute |
| Mental model | Autonomous coding agent — no approval prompts | Auditable governed pipeline |
| When to use | Daily dev work, questions, small fixes, autonomous fixes | Complex changes, multi-file edits, risk-sensitive tasks |

## What This Does NOT Change

The near-term product is still **not**:

- a public commercial devtool
- a provider-agnostic production control plane
- a market-parity claim against Codex, Claude Code, Cursor, Gemini CLI, Aider,
  or OpenHands — the parity benchmark remains YELLOW/RED with `claim_ready: false`
- a platform for mutating live subagents

**Autonomous operation is the goal, not an exclusion.** Chat mode executes
mutations (write_file, apply_patch, run_command) without requiring user approval
for each action. Network-touching commands (curl, npm install, pnpm add, yarn
add, wget) are hard-denied by policy — the model cannot run them without
user intervention. The circuit breaker (5 consecutive policy blocks → session
terminates) and the sandbox execution profile provide safety without the
interactive approval tax that Claude Code and Codex impose.

"Comparable to Claude Code or Codex" refers to product category — interactive
coding agent CLI — and the goal is to **surpass** them on autonomy: fewer prompts,
faster execution, same or better safety through automated guards rather than
human-in-the-loop approval.

### Future Autonomy Evolution (deferred)

Two paths are deferred for when readiness matures:

- **B — Full-auto preset (`'auto'`):** A new policy preset that removes the
  network-command special case entirely. Every tool call runs without denial or
  approval. Safety relies entirely on sandbox execution profiles and the circuit
  breaker. Not yet implemented.
- **C — Graduated env flag (`BABEL_ALLOW_NETWORK_COMMANDS=1`):** Promotes
  `workspace_write` to allow network-touching commands without a new preset.
  Gives power users a one-flag escape hatch. Not yet implemented.

### Ollama offline — experimental add-on (locked 2026-07-12)

**Decision: keep Ollama offline mode experimental.** Do not promote to default
mainline provider until a separate readiness pass.

| Aspect | Lock |
|--------|------|
| Status | **Experimental** on `the feature branch` and any merge of that work |
| Purpose | Future offline / no-API-credits / no-network fallback when cloud providers are unavailable or budget-constrained |
| Not | Default production path; not a substitute for DeepSeek (or other cloud) eval claims |
| When to promote | Explicit product decision after harness honesty (P0–P1), offline smoke, and docs for setup/limits |
| Until then | Ship and document as optional local provider; prefer cloud models for SWE-A and claim-facing gates |

This is a **feature add-on**, not identity or default routing. Chat-mode pass-rate
work must not block on Ollama promotion.

### Mode surface + contracts (locked 2026-07-12)

| Decision | Lock |
|----------|------|
| **chat vs chat-headless** | **Hybrid C**: keep `chat-headless` as a **stable mode alias**. Preferred long-term form: `babel chat --headless` (and `run --mode chat --headless`). Same ChatEngine; headless is dress, not a second product. |
| **PipelineModeSchema** | **Hard cut**: Zod enum is live modes only — `chat \| chat-headless \| plan \| deep`. Legacy names (`direct`, `verified`, `autonomous`, `manual`, `parallel_swarm`) are **not** schema values; use `normalizePipelineMode` only at ingest edges before parse. CLI argv may still map legacy names with deprecation warnings. |
| **PR shape** | **Split**: harness honesty PRs separate from Ollama experimental PR/branch. |
| **Missing verifier hard-block** | **Headless/CI only**: when `hardGate` (BABEL_HEADLESS=1, CI=1, or non-TTY), policies `required` and `strict` reject-continue then **hard-BLOCK** after max strikes — no soft-allow of missing authoritative verifier. Interactive chat may soft-allow `required`. |

```text
babel "<task>"              → chat (interactive)
babel chat --headless "…"   → chat-headless (preferred long-term form)
babel chat-headless "…"     → same (stable alias)
babel plan / deep           → governed pipeline
```

## Daily Loop (unchanged from v1)

All near-term work should serve this loop:

```text
fresh clone/setup
-> first useful read-only task
-> plan
-> proposed diff or safe fix
-> diff/review
-> verify
-> rollback/recovery
-> reusable workflow evidence
```

## Active Architecture Truth

```text
babel "<task>"          → AgentSession → ChatEngine (multi-turn tool loop, no orchestrator)
babel chat-headless     → AgentSession → ChatEngine (same loop, JSON output)
babel plan              → PlanTask (approval-first, then apply + verify)
babel deep              → GovernedTask (full pipeline: orchestrate → plan → review → execute)
babel undo              → restore last checkpoint
```

## Fresh-Clone Proof Commands (unchanged)

```powershell
npm --prefix .\babel-cli run build
npm --prefix .\babel-cli run test -- --test-path-pattern="agent|workflowCommands|argv|liteUsability|checkpoints|ciReview"
node .\babel-cli\dist\index.js benchmark lite --json
node .\babel-cli\dist\index.js benchmark production --json
npm run test:public-release
```

## Claim Boundaries

Safe wording:

> Babel is an autonomous conversational Coding Agent CLI with an optional governed
> pipeline mode (Prompt OS) for high-stakes work. The coding agent surface is the
> default daily path, executing file writes, patches, and shell commands without
> user approval — surpassing Claude Code and Codex on autonomy. Network-touching
> commands (curl, npm install) are hard-denied by policy, not prompted. The Prompt
> OS mode is opt-in for tasks that benefit from structured review and verification.
> The scoped DeepSeek-backed governed CLI lane has a claim-ready production gate,
> but broader production, market-parity, and mutating-subagent claims remain
> excluded.

Unsafe wording until further proof:

- provider-agnostic production AI control plane
- market parity with Codex, Claude Code, Cursor, Gemini CLI, Aider, or OpenHands
- verifier-mandatory for every run
- mutating live subagents
- public-ready devtool
