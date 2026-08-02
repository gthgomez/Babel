<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

<!--
status: ACTIVE
last_verified: 2026-08-01
-->

# Babel Architecture

> **Role**: Deep technical reference — how Babel works internally. Layer model, catalog system, router, pipeline, and layer precedence.
> For what Babel is and how to invoke it, see [BABEL_BIBLE.md](../../BABEL_BIBLE.md).
> For AI-session navigation and invariants, see [CLAUDE.md](../../CLAUDE.md).

## Overview

Babel is an autonomous Coding Agent CLI with optional governed pipeline mode (Prompt OS). It assembles task-relevant instructions in a deterministic resolver/compiler path, then hands the compiled context to the runtime or model-facing layer. Current evidence supports the resolver/compiler, catalog, schema, status, rollback, verifier-contract, doctor, and local-test surfaces; it does not yet demonstrate production readiness or broad live-provider governance.

The core design principle: **separate what the model knows from how it behaves**. Behavioral rules (PLAN before ACT, execution gates, epistemic honesty) live in one layer. Domain knowledge (backend engineering, frontend patterns, compliance rules) lives in another. A third layer shapes model-specific output style. These layers compose — they do not override each other.

## Unified Execution Kernel

The daily ChatEngine path and the governed plan/deep profiles share a
mode-neutral executor substrate. `babel-cli/src/executor/kernel.ts` owns the
executor contract, effect classification, completion boundary, and durable
effect identifiers; `babel-cli/src/agent/chatEngineServices.ts` remains the
composition boundary for conversation serialization, provider-message replay,
tool definitions, canonical tool-name normalization, and progress-controller
creation. `chat` and `deep` retain mutation capability behind their existing
policy and verification gates; `plan` uses the same substrate with read-only
effect enforcement and a separate plan-artifact completion path.

Model-facing names (`read_file`, `run_command`, `write_file`) are normalized at
the boundary to executor names (`file_read`, `shell_exec`, `file_write`). The
bidirectional map lives in `babel-cli/src/agent/canonicalToolMapping.ts`, so
provider aliases and governed executor logs cannot silently grow separate tool
vocabularies. The kernel does not replace the V9 orchestrator or weaken deep
mode's QA/evidence stages; it supplies their shared runtime contracts.

---

## The Six Runtime Layers

Babel stacks are assembled from up to six runtime prompt layers, loaded in this order.
(These are the layers loaded into the model's context at execution time. `00_System_Router/`
and `04_Meta_Tools/` are **infrastructure layers** — the router selects layers and the
meta tools author/audit them, but neither is included in the runtime prompt stack.)

### 1. Behavioral OS (`01_Behavioral_OS/`)

Loaded first, always. Governs:

- The PLAN → ACT state machine (no action without a plan)
- Execution gates (what requires human confirmation before proceeding)
- Epistemic honesty rules (observed vs inferred vs unknown)
- Anti-eager behavior (no speculative file writes, no hallucinated completions)

**Canonical live variant:** `OLS-v11-Core-Unified.md` (`behavioral_core_v11`) — a single consolidated behavioral foundation that unifies universal rules, epistemic discipline, execution discipline, and safety guardrails. Supersedes the former three-file split (`OLS-v10-Core-Universal.md`, `OLS-v7-Cognitive-Micro.md`, `OLS-v7-Guard-Auto.md`), which remain on disk as deprecated references only. Behavioral rules apply to every task, every project, every model.

---

### 2. Domain Architect (`02_Domain_Architects/`)

Loaded second. One per task. Governs what the model knows and how it approaches the problem domain:

| ID                      | Domain                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `domain_swe_backend`    | API, database, auth, Supabase, PostgreSQL, RLS               |
| `domain_swe_frontend`   | React, Next.js, design systems, accessibility                |
| `domain_android_kotlin` | Android, Kotlin, Jetpack Compose, Play/Appstore distribution |
| `domain_compliance_gpc` | GPC, GDPR, CCPA, privacy regulation                          |
| `domain_devops`         | CI/CD, Docker, Vercel, Terraform, migrations                 |
| `domain_research`       | Structured investigation, strategy, synthesis                |

The Domain Architect is the primary expertise layer. It defines invariants (e.g. "RLS must be enabled on every table"), recommended tools, and the lens through which the model reads the task.

---

### 3. Skills (`02_Skills/`)

Zero or more per task. Loaded after the Domain Architect. Each skill is a focused, reusable technical rule set that the domain alone doesn't cover:

| ID                     | Skill                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `skill_ts_zod`         | TypeScript strict typing and Zod validation rules                                                                           |
| `skill_supabase_pg`    | Supabase/Postgres RLS, migration, and naming rules                                                                          |
| `skill_react_nextjs`   | React/Next.js component state and performance rules                                                                         |
| `skill_a11y_design`    | WCAG 2.2 AA and semantic HTML accessibility rules                                                                           |
| `skill_bcdp_contracts` | Breaking Change Detection Protocol — consumer identification, COMPATIBLE/RISKY/BREAKING classification, migration artifacts |

Skills are selected by the resolver by task shape and local runtime context. Domain architects declare `default_skill_ids` for their common pairings. The resolver expands skill dependencies automatically and can apply JIT/semantic skill routing with token-budget awareness so selection remains behaviorally bounded while still context-appropriate.

When `02_Skills/.compiled/` exists for a skill set, the resolver prefers private compiled skill cache artifacts there for execution speed. Public exports omit this directory.

---

### 4. Model Adapter (`03_Model_Adapters/`)

One per task. Shapes how the model formats and delivers its output:

| ID                 | Model              | Purpose                                                                   |
| ------------------ | ------------------ | ------------------------------------------------------------------------- |
| `adapter_claude`   | Claude Sonnet/Opus | Suppresses over-helpfulness, enforces PLAN→ACT gating                     |
| `adapter_fallback` | Fallback lane      | Ultra-terse output, dense algorithmic tasks                               |
| `adapter_standard` | Standard lane      | Balanced output for multi-file refactors and architecture-sensitive edits |
| `adapter_gemini`   | Gemini             | Optimized for long-context document synthesis and log analysis            |

Adapters are pure style — they contain no domain knowledge. They must not weaken Behavioral OS rules.

---

### 5. Project Overlay (`05_Project_Overlays/`)

Zero or one per task. A thin layer of project-specific context: stack details, hard constraints, naming conventions. Keeps the Domain Architect generic while giving the model the facts it needs for a specific codebase.

Current overlays: `overlay_example_saas_backend`, `overlay_example_llm_router`, `overlay_example_web_audit`, `overlay_example_mobile_suite`.

**Rule:** If a project overlay grows beyond ~400 tokens of meaningful content, it should be split into domain-level invariants (belong in the Domain Architect or a skill) and actual project-specific context (stays in the overlay).

---

### 6. Task Overlay (`06_Task_Overlays/`)

Zero or more per task. Optional, bounded, reusable guidance for a specific type of work — not a specific project. Example: `task_frontend_professionalism` refines UI polish work without changing domain invariants.

Task overlays must not override project invariants or behavioral rules. They are strictly additive.

---

## The Catalog (`prompt_catalog.yaml`)

The catalog is the single source of truth for all registered prompt files. Every Babel layer file that can be routed to must have a catalog entry. The catalog records:

- `id` — unique identifier used by the router and resolver
- `layer` — which of the six layers this file belongs to
- `path` — path relative to the Babel root
- `status` — `active` or `deprecated`
- `dependencies` — other skill IDs this skill requires (resolved automatically)
- `conflicts` — IDs that cannot be loaded alongside this file
- `token_budget` — estimated token cost for context management
- `default_skill_ids` — skills a domain architect loads by default

**Invariant:** No prompt file is canonical unless it is listed in `prompt_catalog.yaml`.

---

## The Router (`00_System_Router/`)

### OLS-v9 Orchestrator (default typed routing lane)

The v9 orchestrator is the active typed runtime lane. It:

1. Reads the user's request
2. Matches it to a project (`example_saas_backend`, `example_llm_router`, `example_web_audit`, `example_mobile_suite`, or `global`)
3. Classifies the task type (Frontend / Backend / Mobile / Compliance / DevOps / Research)
4. Emits one typed `analysis.purpose_mode` for the task's primary purpose (`execution`, `verification`, `learning`, `exploration`, or `audit`)
5. Selects the minimum correct set of layer IDs
6. Emits a strict JSON routing manifest built around `instruction_stack` plus `resolution_policy` — not file paths

`purpose_mode` only seeds bounded generic cognition. It must not choose the domain, weaken governance, replace domain defaults, or make cognition ambient in routine SWE lanes.

Output is a typed manifest:

```json
{
  "analysis": {
    "task_category": "Backend",
    "routing_confidence": 0.95
  },
  "compilation_state": "uncompiled",
  "instruction_stack": {
    "behavioral_ids": ["behavioral_core_v11"],
    "domain_id": "domain_swe_backend",
    "skill_ids": ["skill_ts_zod", "skill_supabase_pg"],
    "model_adapter_id": "adapter_standard",
    "project_overlay_id": "overlay_example_saas_backend",
    "task_overlay_ids": [],
    "pipeline_stage_ids": ["pipeline_qa_reviewer"]
  },
  "resolution_policy": {
    "apply_domain_default_skills": true,
    "expand_skill_dependencies": true,
    "strict_conflict_mode": "error"
  },
  "prompt_manifest": []
}
```

The downstream resolver/compiler owns path resolution and prompt assembly. After resolution, `compiled_artifacts` and the root `prompt_manifest` carry the ordered file list consumed downstream.

### OLS-v8 Orchestrator (retired)

`OLS-v8` is no longer part of the live runtime contract. It remains only as historical context in repository history for migration reference.

---

## The Compile + Dispatch Pipeline (babel-cli)

When running via `babel-cli`, the assembled instruction stack flows through a four-stage pipeline:

```
Stage 1: Orchestrator  → emits typed routing manifest (Llama-4-Scout primary, DeepSeek-V4-Flash / Qwen3-32B fallback)
Stage 2: SWE Agent     → produces MINIMAL_ACTION_SET plan (Llama-4-Scout primary, DeepSeek-V4-Pro / Step-3.5-Flash / Qwen3-32B fallback)
Stage 3: QA Reviewer   → adversarially audits plan (DeepSeek-V4-Pro primary, Nemotron-3-Super / Step-3.5-Flash / Qwen3-32B fallback)
Stage 4: CLI Executor  → executes approved plan step-by-step (DeepSeek-V4-Pro primary, DeepSeek-V4-Flash / Llama-4-Scout / Qwen3-32B fallback)
```

Each stage uses a dedicated LLM waterfall — a priority-ordered list of runner tiers that cascade on failure. Waterfall chains are sourced from `config/model-policy.json` (the single source of truth for stage routing). Zod schemas validate every stage's JSON output before the pipeline advances.

The QA Reviewer operates on six audit layers: Evidence Gate, SFDIPOT coverage, NAMIT code-level checklist, BCDP contract verification, Security audit, and Root Cause verification. It outputs only `PASS` or `REJECT`. On `REJECT`, the pipeline loops back to the SWE Agent with tagged failure reasons and a directional fix hint.

### Evidence Limits

The architecture above is implemented and locally tested in important parts, but it is not a production-readiness claim. Provider-backed pipeline tests may require API keys and can be skipped; live-model compliance with PLAN -> QA -> ACT must be proven with saved run artifacts before Babel is described as a reliable autonomous worker.

---

## Layer Precedence

When layers conflict, higher layers win:

```
Behavioral OS  >  Domain Architect  >  Skills  >  Model Adapter
                                      Project Overlay  >  Task Overlay
```

A task overlay cannot weaken a Domain Architect invariant.
A model adapter cannot override Behavioral OS execution gates.
A project overlay cannot introduce domain-level rules — those belong in the Domain Architect.

---

## How to Add a New Layer File

1. Read [04_Meta_Tools/Role_Creation_Gate.md](../../04_Meta_Tools/Role_Creation_Gate.md)
2. Confirm the file cannot be replaced by an existing file or a task overlay
3. Write the file following the applicable layer spec
4. Register it in `prompt_catalog.yaml` with a unique ID, correct layer, path, and status
5. If it's a skill with dependencies, declare them in the catalog entry
6. Run `tools/validate-catalog.ps1` — must exit clean

**Layer-specific rules:**

- **Behavioral OS**: universal only — no project or domain specifics
- **Domain Architect**: broad primary expertise — no model-style guidance
- **Skill**: focused, reusable technical rules — no domain architecture
- **Model Adapter**: style and output shape only — no domain knowledge
- **Project Overlay**: thin context only — no new invariants
- **Task Overlay**: additive, bounded, reusable — must not override stronger layers

---

## Portability Notes

Babel's routing contracts use `<YOUR_PROJECT_ROOT>` as a placeholder for the absolute repo path. Local runtime configurations substitute the actual path at runtime. Public-facing docs use relative links.

The babel-cli source is Windows-first in its path handling but includes cross-platform guards (`path.join()`, `process.platform` checks) throughout.
