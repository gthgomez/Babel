# CLAUDE.md — Babel (Project-Specific)

> Complements the root `../CLAUDE.md` which contains universal workflow rules.
> This file contains only Babel-specific context and invariants.

## Startup Sequence

1. `BABEL_BIBLE.md` — entrypoint, layer model, workflow, non-negotiables
2. `PROJECT_CONTEXT.md` — system topology, contracts, run discoveries
3. `prompt_catalog.yaml` — canonical source of truth for prompt versioning and file paths
4. This file — invariants and boundaries

## Babel Local Mode

If the user says `use Babel`, `read the Bible`, or asks for prompt-stack assembly, routing, or control-plane work, treat Babel Local Mode as active.

Canonical entrypoint:
`BABEL_BIBLE.md`

In Babel Local Mode:
1. Read `BABEL_BIBLE.md`.
2. Read `PROJECT_CONTEXT.md`.
3. Read `prompt_catalog.yaml`.
4. Load only the relevant Babel rules, skills, and prompt layers.
5. Follow the assembled stack before planning or acting.

Do not improvise the Babel stack from memory.

## Repo Scope

| Layer | Path |
|-------|------|
| System Router | `00_System_Router/` |
| Behavioral OS | `01_Behavioral_OS/` |
| Domain Architects | `02_Domain_Architects/` |
| Skills | `02_Skills/` |
| Model Adapters | `03_Model_Adapters/` |
| Meta Tools | `04_Meta_Tools/` |
| Project Overlays | `05_Project_Overlays/` |
| Task Overlays | `06_Task_Overlays/` |
| Prompt Catalog | `prompt_catalog.yaml` |

## Critical Invariants

1. **V9 Orchestrator** (`OLS-v9-Orchestrator.md`) is the default typed runtime lane — preserve its routing contract
2. **V8 Orchestrator** (`OLS-v8-Orchestrator.md`) is the compatibility fallback lane — do not remove or break it
3. **Behavioral OS / Domain Architect separation** — "how the model behaves" vs "what the model knows" must stay strictly separated
4. **Global breaking changes** — edits to `01_Behavioral_OS/` or `RULES_CORE.md`/`RULES_GUARD.md` affect ALL downstream agents across ALL projects
5. **`prompt_catalog.yaml`** is the single source of truth for prompt versioning and file paths — no prompt file is canonical unless listed here

## High-Risk Zones

- `00_System_Router/OLS-v9-Orchestrator.md`
- `00_System_Router/OLS-v8-Orchestrator.md`
- `01_Behavioral_OS/*`
- `prompt_catalog.yaml`
- `04_Meta_Tools/Prompt_Compiler-v4.1.md`

## Special Rules

- Never break the V9 Orchestrator input/output JSON contract (primary lane)
- Never break the V8 Orchestrator contract (compatibility lane — active fallback)
- Never invent prompt files that are not in `prompt_catalog.yaml` unless explicitly asked to author new Babel files
- Never introduce circular dependencies between prompt overlays and meta-tools
- Never use more layers than necessary — assemble the smallest correct instruction stack
- Never let style/task overlays weaken project invariants or behavioral rules
- All Domain Architects must follow their respective vX specs
- Maintain strict versioning and path integrity in `prompt_catalog.yaml`

## Local Run Discipline

When working in a local/editor session:
- Start: `tools/launch-babel-local.ps1` (or `tools/start-local-session.ps1`) — prints required env vars
- End: `tools/end-local-session.ps1`
- Required lifecycle artifacts: `runs/local-learning/session-starts/`, `runs/local-learning/session-ends/`, `runs/local-learning/session-log.jsonl`
- Audit consistency: `tools/report-run-consistency.ps1`
- A run without lifecycle artifacts is protocol-incomplete and non-canonical for Local Mode learning

## Context Sync

After substantial runs, update `PROJECT_CONTEXT.md` if system topology or orchestrator behavior changed.

## Deep Dive

For full rule layers: `LLM_COLLABORATION_SYSTEM/` (RULES_CORE, RULES_GUARD, ADAPTER_BABEL, RULES_MODEL_CLAUDE)
