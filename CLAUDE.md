# CLAUDE.md — Babel (Public Canonical Source)

> **Role**: Entry point for AI sessions in the Babel public repo (`gthgomez/Babel`). This is the **canonical OSS source of truth** for the Babel coding agent. Startup sequence, repo architecture, invariants, high-risk zones, and common task paths.
> For what Babel is and how to invoke it, see [BABEL_BIBLE.md](./BABEL_BIBLE.md).
> For deep technical architecture, see [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md).

> **TL;DR**: You are in the Babel product repo. Don't break the V9 orchestrator, the prompt catalog, or Behavioral OS. Validate changes with `pwsh tools/validate-catalog.ps1`. For CLI code changes, run `cd babel-cli && npm test`.

## Repository Identity

This is the **public, canonical source** for the Babel coding agent (`gthgomez/Babel`). All active product development happens here. The private vault (`Babel-private`) holds only secrets, config, and migration evidence — it is NOT the product trunk.

- **Source work**: clone, branch, PR on this repo
- **Private vault**: `C:\Workspace\Babel-private` — `.env` secrets, `config/project-aliases.json`, migration evidence, frozen export pipeline, generated artifacts, session handoffs
- **Authority model**: See `docs/migration/CANONICAL-OSS-FOUNDATION.md` (in the vault) for the full bidirectional sync design

**This is "Option A"**: the public repo is fully independent. Private→public write is permanently frozen (remote push disabled, script guarded).

## Quick Traverse — Where to Find

| You need… | Look in… |
|-----------|----------|
| What is Babel, how to invoke it | `BABEL_BIBLE.md` |
| System topology, contracts, runtime | `PROJECT_CONTEXT.md` |
| Full catalog of every prompt/skill/rule | `prompt_catalog.yaml` |
| How the CLI routes tasks (the orchestrator) | `00_System_Router/OLS-v9-Orchestrator.md` |
| Shared runtime artifact schemas | `00_System_Router/Babel_Runtime_Contracts-v1.0.md` |
| Behavioral rules (PLAN|ACT, Evidence Gate) | `01_Behavioral_OS/` + `LLM_COLLABORATION_SYSTEM/RULES_CORE.md` |
| Domain knowledge (Backend, Frontend, etc.) | `02_Domain_Architects/` |
| Reusable skills (governance, testing, etc.) | `02_Skills/` |
| Model-specific adapter rules | `03_Model_Adapters/` + `LLM_COLLABORATION_SYSTEM/RULES_MODEL_CLAUDE.md` |
| Meta-tools (compiler, tester, auditor) | `04_Meta_Tools/` |
| Project-specific context overlays | `05_Project_Overlays/` |
| Task-specific guidance overlays | `06_Task_Overlays/` |
| CLI runtime source code | `babel-cli/src/` |
| CLI tests | `babel-cli/src/**/*.test.ts` |
| CLI package scripts | `babel-cli/package.json` |
| CI workflows | `.github/workflows/` |
| Agent/skill lifecycle & execution rules | `AGENTS.md`, `.agents/rules/` (`05`-`08`), `.agents/skills/` |
| Autonomous goal clearance & research delegation | `.agents/rules/06-autonomous-goal-clearance.md`, `.agents/rules/07-subagent-research-delegation.md` |
| Docs (architecture, ADRs, audits, plans, guides, status, research, release) | `docs/` — start with `docs/README.md` |
| Embedding & vector index decision | `docs/adr/ADR-011-embedding-decision.md` |
| Coding standards | `ENGINEERING.md` |
| Public content policy & secret scan | `tools/check-public-content-policy.ps1`, `tools/run-public-secret-scan.ps1` |
| Private vault (secrets, handoffs, migration evidence) | `C:\Workspace\Babel-private\` — see `docs/migration/VAULT-INVENTORY.md` there |

## Repo Layer Architecture

```
User-facing surface (README.md, BABEL_BIBLE.md)
Control plane (prompt layers assembled into instruction stacks):
  00_System_Router/     ← orchestrator + runtime contracts
  01_Behavioral_OS/     ← how the model behaves
  02_Domain_Architects/ ← what the model knows
  02_Skills/            ← reusable technical modules
  03_Model_Adapters/    ← model-specific tuning
  04_Meta_Tools/        ← prompt compiler/tester/auditor
  05_Project_Overlays/  ← per-project context files
  06_Task_Overlays/     ← per-task guidance
Runtime:
  babel-cli/            ← CLI harness, pipeline, TUI
  babel-cli/src/        ← TypeScript source
  babel-cli/dist/       ← compiled output
Support:
  tools/                ← PowerShell automation
  docs/                 ← architecture, plans, status, ADRs
  config/               ← static configuration
  examples/             ← example outputs
  .github/workflows/    ← CI/CD
  LLM_COLLABORATION_SYSTEM/ ← foundational rule documents
  .agents/              ← agent lifecycle rules + skills
```
For the full layer model description and interpretation rules, see [BABEL_BIBLE.md](./BABEL_BIBLE.md) §Layer Model.

## Startup Sequence

**On every session start**, this file (CLAUDE.md) is your entry point — it covers invariants, high-risk zones, and common task paths.

**When Babel control-plane work is requested** (`use Babel`, prompt-stack assembly, routing, catalog changes), load:
1. `BABEL_BIBLE.md` — entrypoint, layer model, workflow
2. `PROJECT_CONTEXT.md` — system contracts and hot paths
3. `prompt_catalog.yaml` — canonical source of truth for prompt versioning and file paths
4. This file — invariants, high-risk zones, special rules, common task paths

## Babel Harness

The TUI provides chat, plan, and deep modes with automatic session tracking, resume, and cost monitoring. For what Babel is and how to launch it, see [BABEL_BIBLE.md](./BABEL_BIBLE.md).

When working on the Babel control plane itself (prompt stack assembly, routing, catalog changes), load the relevant Babel layers per the [Startup Sequence](#startup-sequence) above. Do not improvise the Babel stack from memory.

## Relationship: This File vs babel-cli/CLAUDE.md

| File | Scope | Contains |
|------|-------|----------|
| `CLAUDE.md` (this file) | Whole Babel control plane | Repo invariants, layer architecture, high-risk zones |
| `babel-cli/CLAUDE.md` | babel-cli package only | Coding standards, event-loop rules, testing discipline, chat-mode invariants |

The root CLAUDE.md takes precedence for cross-project rules. `babel-cli/CLAUDE.md` is the authority for CLI-specific coding standards.

## Relationship: Public Repo vs Private Vault

| Aspect | Public (`gthgomez/Babel`) | Private (`Babel-private`) |
|--------|--------------------------|---------------------------|
| Role | Canonical product source | Secrets/config vault |
| Active development | **Here** | Frozen |
| Prompt layers | **Authoritative** copies | Local copy for TUI execution only |
| `.env` / secrets | None — use env vars or Credential Manager | Vault holds `.env` |
| Handoff chain | New chain (starts here) | Historical chain (archive) |
| CI/CD | Public Actions workflows | Vault CI (if any) |
| Git remote | `origin` = `gthgomez/Babel` | Local only / no push |

**Rule**: When you need Babel source code, prompt layers, tools, CI workflows, or security policy — this is the repo. The private vault exists only for secrets and historical evidence. Never commit secrets, credentials, or private paths to this repo.

## Critical Invariants

1. **V9 Orchestrator** (`OLS-v9-Orchestrator.md`) is the only live typed runtime lane — preserve its routing contract
2. **Legacy V8 references** are historical compatibility notes only. Do not describe `OLS-v8-Orchestrator.md` as an active fallback unless runtime support is reintroduced in the same change set.
3. **Behavioral OS / Domain Architect separation** — "how the model behaves" vs "what the model knows" must stay strictly separated
4. **Global breaking changes** — edits to `01_Behavioral_OS/` or `RULES_CORE.md`/`RULES_GUARD.md` affect ALL downstream agents across ALL projects
5. **`prompt_catalog.yaml`** is the single source of truth for prompt versioning and file paths — no prompt file is canonical unless listed here
6. **Prompt/runtime co-evolution** — if `babel-cli/src/agentContracts.ts` or any `build*Task` function in `pipeline.ts` is changed, the corresponding prompt file must be updated in the same change set. Runtime-only changes that extend a model contract are incomplete changes.

## High-Risk Zones

- `00_System_Router/OLS-v9-Orchestrator.md`
- `01_Behavioral_OS/*`
- `prompt_catalog.yaml`
- `04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`
- `babel-cli/src/schemas/agentContracts.ts` — Zod output contracts; changes here require prompt co-evolution
- `babel-cli/src/pipeline.ts` (`build*Task` functions) — runtime task injection; changes here require prompt co-evolution
- `LLM_COLLABORATION_SYSTEM/RULES_CORE.md` — behavioral foundation for all agents
- `LLM_COLLABORATION_SYSTEM/RULES_GUARD.md` — safety guard for all agents
- `.github/workflows/` — public CI; changes here affect all PRs

## Special Rules

- Never break the V9 Orchestrator input/output JSON contract (primary lane)
- Do not revive or depend on a V8 compatibility lane unless runtime support and tests are added in the same change set
- Never invent prompt files that are not in `prompt_catalog.yaml` unless explicitly asked to author new Babel files
- Never introduce circular dependencies between prompt overlays and meta-tools
- All Domain Architects must follow their respective vX specs
- Maintain strict versioning and path integrity in `prompt_catalog.yaml`
- **Never commit secrets, API keys, tokens, or private paths to this repo** — use environment variables or Windows Credential Manager for credentials. Public CI scans (`gitleaks`, `check-public-content-policy.ps1`) will catch leaks.

## Environment Gotchas (Windows + Git Bash)

These are the most frequent tool failures observed across sessions. Follow them to avoid rediscovering them:

1. **Always use absolute, forward-slash paths in Bash commands.** Windows backslash paths get their backslashes stripped inside bash (`C:\Workspace\...` becomes `C:Workspace...`). Use `C:/Workspace/...` or `/c/Workspace/...`.
2. **Know where you are before `cd babel-cli`.** The npm workspace lives at `<repo-root>/babel-cli/`. `cd babel-cli` fails when the shell is already inside `babel-cli/` or anywhere other than repo root, and produces doubled paths like `babel-cli/babel-cli/src/...`. Prefer absolute paths: `cd C:/Workspace/Babel-public-live/babel-cli`.
3. **Scope searches — unscoped `rg`/Grep over the repo root times out.** Default to `babel-cli/src/` for runtime code, the specific prompt-layer directory for control-plane work. Never search `runs/`, `artifacts/`, `runtime/`, `node_modules/`, or `dist/`. The `.rgignore` file at repo root enforces these exclusions for ripgrep-based tools.
4. **Run the File Size Ratchet check before committing** (it is part of CI and fails late otherwise): run `pwsh tools/check-architectural-budget.ps1` before pushing when you touched large files.
5. **Fanning out subagents that edit files: partition file ownership first.** Concurrent subagents editing the same file (historically `babel-cli/src/agent/chatEngine.ts`) cause "File has been modified since read" errors and merge conflicts. Assign each subagent a disjoint set of files, and confirm the worktree is clean before fan-out.
6. **CI/PR checks via `gh`:** `gh pr view --json statusChecks` is invalid — the field is `statusCheckRollup`. `gh pr checks` exits 8 while checks are *pending*; that is not a failure. A brand-new branch may report "no checks reported" until the first workflow starts — wait and retry rather than diagnosing.
7. **Self-hosted Windows CI runners** may show "online" in GitHub but be dead — the agent process hangs despite a live connection. Restart the runner agent service on the host. This is a recurring pattern. [INFERRED from session retrospective 2026-07-23]
8. **CI artifact retention** must be ≥7 days for workflow re-runs. The `babel-dist` artifact was set to `retention-days: 1` which caused silent re-run failures. Current value in `ci.yml` is 7. [INFERRED from session retrospective 2026-07-23]
9. **Windows sandbox timing thresholds** need 5000ms headroom in CI. The 500ms default is too tight for Windows self-hosted runners. Documented in CI notes. [INFERRED from session retrospective 2026-07-23]
10. **Pre-commit hooks on Windows** need a bash entrypoint that delegates to `.ps1` scripts. Direct PowerShell hooks fail under Git Bash. Use the pattern: bash script → `pwsh -File script.ps1`. [INFERRED from session retrospective 2026-07-23]
11. **Scrub config regex escaping**: PowerShell/JSON escaping layers can turn `\\b` (word boundary) into literal `b`. When editing scrub rules in `tools/public-export/scrub_config.json`, verify regex escaping survives the double-layer (JSON parse → PS string). [INFERRED from session retrospective 2026-07-23]

## Common Task Paths

| Task | Entry point |
|------|------------|
| Run the CLI tests | `cd babel-cli && npm test` |
| Type-check the CLI | `cd babel-cli && npx tsc --noEmit` |
| Build the CLI | `cd babel-cli && npm run build` |
| Validate catalog + audit + domain policy (all 3) | `pwsh tools/validate-all.ps1` |
| Validate prompt catalog | `pwsh tools/validate-catalog.ps1` |
| Audit skill disk drift | `pwsh tools/audit-skill-disk-drift.ps1` |
| Test domain default policy | `pwsh tools/test-domain-default-policy.ps1` |
| Check repo map consistency | `pwsh tools/report-run-consistency.ps1` |
| **Pre-push ratchet check** | `pwsh tools/preflight-ratchet.ps1` |
| **Local CI dry-run (Docker)** | `pwsh tools/ci-dry-run.ps1` |
| Public content policy check | `pwsh tools/check-public-content-policy.ps1 -RepoRoot .` |
| Public secret scan (strict) | `pwsh tools/run-public-secret-scan.ps1 -RepoRoot . -Strict -RequireExternalScanner` |
| Update handoff | `/handoff` |
| Resume from handoff | `/handoff-resume` |

### Testing Discipline (mandatory before push)

From session retrospective analysis: all 10 reviewed sessions deferred testing entirely to CI. This wastes 2-5 minutes per feedback loop vs <30 seconds locally.

- **Before committing CLI changes**: run `cd babel-cli && npx tsc --noEmit && npm test`
- **Before pushing**: run `pwsh tools/preflight-ratchet.ps1` if you touched large files
- **After catalog/routing changes**: run `pwsh tools/validate-all.ps1`
- **Before opening a PR**: run full CI dry-run `pwsh tools/ci-dry-run.ps1`

## Workflow Skills

| Skill | Use when |
|-------|---------|
| `/ratchet-preflight` | Before pushing — check file-size budgets locally |
| `/ci-dry-run` | Before pushing — run CI build+test in Docker |
| `/catalog-validate-all` | After catalog/routing changes — run the validation trio |
| `/branch-stack` | Working on sequential dependent feature branches |
| `/evidence-compile` | Auto-update implementor roadmap status from git history |

## Tool-Use Patterns (learned from session data)

These patterns are observed to be effective in this repo. Prefer them over alternatives:

- **Use `Grep` for content search, not `Bash` + `grep`/`rg`.** Grep produces cleaner context entries without shell overhead. Always provide an explicit `path` to scope the search.
- **Use `Glob` with an explicit `path` parameter.** Unscoped Glob calls timeout on this repo (20s default). Always provide a subdirectory: `babel-cli/src/`, `docs/`, `.github/`, etc.
- **Use `LSP` for TypeScript symbol navigation.** `goToDefinition`, `findReferences`, and `hover` are available and faster than grep-based symbol hunting in `babel-cli/src/`.
- **Use `Read` over `Bash cat`/`head`/`tail` for file inspection.** Read produces cleaner context and avoids shell overhead.
- **Batch sub-agent launches with `parallel()`** when dispatching 3+ independent agents. Sequential one-per-turn launches waste ~30 seconds per agent in round-trip overhead.
- **Use `TaskOutput` with `block:true`** for sub-agent completion handshakes, not SendMessage polling.
- **Use `Monitor` for polling workflows**, not `sleep` in Bash. The tool-use policy blocks sleep+command patterns.

## Pre-PR Checklist

Before opening a PR on this repo:

1. `cd babel-cli && npx tsc --noEmit` — types must pass
2. `cd babel-cli && npm test` — all tests must pass
3. `pwsh tools/check-public-content-policy.ps1 -RepoRoot .` — content policy must pass
4. `pwsh tools/run-public-secret-scan.ps1 -RepoRoot . -Strict -RequireExternalScanner` — zero leaks
5. `pwsh tools/preflight-ratchet.ps1` — file sizes within budget (if you touched large files)
6. Branch from and PR to `main`; use conventional commit prefixes (no `codex/` prefix per memory)

## Repo Cleanup Policy

After catalog or routing changes, run:
- `pwsh tools/validate-catalog.ps1`
- `pwsh tools/audit-skill-disk-drift.ps1`
- `pwsh tools/test-domain-default-policy.ps1` (if domain `default_skill_ids` changed)

After CLI source changes, use the targeted `babel-cli` checks listed in `babel-cli/PROJECT_CONTEXT.md`.

**Key rules:**
- Prefer adding indexes, labels, and docs lanes before moving many files.
- **Documentation Co-Evolution**: When adding `.agents/rules/`, ADRs (`docs/adr/`), or archiving historical docs into `docs/archive/`, update `CLAUDE.md` §Quick Traverse and the section `README.md` index in the same change set. Run `pwsh tools/check-architectural-budget.ps1` before committing.
- Do not move `AGENTS.md`, `PROJECT_CONTEXT.md`, `BABEL_BIBLE.md`, model adapters, or startup files without explicit approval.
- Do not delete run evidence, generated artifacts, or snapshots just because they look noisy.
- Generated paths (`runs/`, `artifacts/`, `runtime/`) can contain important evidence — do not delete or flatten without an explicit cleanup task.

For the full documentation lane map, see [docs/README.md](./docs/README.md).

## Context Sync

After substantial runs, update `PROJECT_CONTEXT.md` if system topology or orchestrator behavior changed.

## Deep Dive

For full rule layers: `LLM_COLLABORATION_SYSTEM/` (RULES_CORE, RULES_GUARD, ADAPTER_BABEL, RULES_MODEL_CLAUDE)

## Session Knowledge

This CLAUDE.md was bootstrapped from private vault session knowledge on 2026-07-24. It incorporates:
- All 6 original Environment Gotchas from the private vault's CLAUDE.md
- 5 additional gotchas discovered during the session retrospective v2 (2026-07-23) — items 7-11
- Tool-use patterns synthesized from 999 tool calls across 10 sessions
- Testing discipline rules from retrospective finding B3-001
- Pre-PR checklist based on public CI gate requirements

For the full retrospective report and remaining action items, see `session-retrospective-20260723-153000.md` in the private vault. The retrospective identified 23 recommendations; the highest-priority ones are encoded in this file's rules and gotchas.
