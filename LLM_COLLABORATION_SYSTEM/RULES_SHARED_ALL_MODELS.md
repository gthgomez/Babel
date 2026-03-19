# Shared Rules For All Models (Codex, Claude, Gemini)

Scope: Entire `Babel` repository.

## v7 Layered Control Plane (Authoritative Sources)

This file is a compatibility aggregate for current manifest generation.
Authoritative layered sources:
- `RULES_CORE.md` (always loaded)
- `RULES_GUARD.md` (conditionally loaded by `ACTIVATION_CONTRACT.yaml`)
- `ADAPTER_BABEL.md` (project invariants)

Load decision policy lives in:
- `ACTIVATION_CONTRACT.yaml`

## Startup Sequence (Mandatory)

1. Read `PROJECT_CONTEXT.md`.
2. Apply this file (`RULES_SHARED_ALL_MODELS.md`).
3. Apply your model overlay (`RULES_MODEL_CODEX.md` or `RULES_MODEL_CLAUDE.md` or `RULES_MODEL_GEMINI.md`).

## Autonomous Scaffolding (Compensatory Agency)

These rules exist to absorb user error and upstream context drift without requiring prompt rewrites.

### Path Resolution (Proactive)

- Treat provided paths as hypotheses, not facts.
- Before using any path in analysis or commands, verify it exists.
- If missing, auto-discover likely replacements using workspace search (`rg --files`, `rg -n`) and continue with corrected paths.
- Record corrections in handoff under `path_corrections`.

### PLAN-Only Scope Interception

- If a PLAN-only task includes feature implementation details, do not produce code/spec changes.
- Replace implementation output with pre-change risk analysis for existing files only.
- Include explicit notice: `Implementation details withheld to maintain strict PLAN-only constraints.`

### Command Portability & Sanity

- Do not output commands that are known-non-portable or logically invalid for the stack.
- Rewrite commands to workspace-valid, copy-paste-safe forms before outputting.
- Record rewrites in handoff under `command_rewrites`.

### Workspace Overlay Handling

- If purpose overlay file is outside allowed workspace, emit inline:
  `[OVERLAY_SKIP] <path>: outside workspace boundary.`
- Continue safely without overlay and summarize missing overlay intent in handoff (`overlay_status`, `context_inject`).

## v7 Safety Gates (Adapted)

### Two-State Execution

- State is always exactly one of: `PLAN` or `ACT`.
- `PLAN`: analyze, identify assumptions, list minimal steps, define verification.
- `ACT`: execute only approved steps.
- If new unknowns appear during `ACT`, stop and return to `PLAN`.

### Evidence Gate (No Blind Edits)

- Never infer unseen file contents.
- If a requested file has not been inspected in the current run, read it first.
- If the requested path is wrong/missing, auto-resolve to existing path(s), then proceed.
- If no plausible path is found, stop and request the relevant file content before planning further edits.

### Anti-Eager Scope Control

- Use the minimal action set that satisfies the objective.
- Do not add refactors or side changes unless explicitly requested.
- Do not expand scope silently; declare scope changes before acting.

### Verification-First Rule

- Every implementation action must include an objective verification method before execution.
- Invalid verification examples: "looks fine", "should work", "seems correct".

### Contract Safety (BCDP)

Before changing contracts (API shape, schema, interface, props):
1. Identify all known consumers.
2. Classify change impact: `COMPATIBLE`, `RISKY`, `BREAKING`.
3. If `RISKY` or `BREAKING`, include migration steps and verification.

### Edge Cases (NAMIT)

For non-trivial changes, check applicable edge cases:
- `N` Null/missing data
- `A` Array/size boundaries
- `M` Concurrency/shared-state (only if relevant)
- `I` Input validation/injection/coercion
- `T` Timing/timeouts/retries (only if relevant)

## Core Execution Rules

1. Treat this repo as the single source of truth for the project's **Behavioral OS**, **Domain Architect**, and **Skill** prompt assets.
2. Maintain strict versioning and path integrity in `prompt_catalog.yaml`.
3. Do not break the live dual-router contract: v9 typed routing is the default runtime lane, and v8 remains the compatibility fallback until retired.
4. Preserve root-level `prompt_manifest` compatibility for downstream runtime consumers even when routing through v9 typed compilation.
5. Do not introduce circular dependencies between prompt overlays, skills, and meta-tools.

## Context Maintenance Rules

At the end of each run:
1. Re-scan touched files plus direct dependencies.
2. Update `PROJECT_CONTEXT.md` if system topology or orchestrator/compiler contracts changed.
3. Add a dated `Run Discoveries` note (or `no drift detected`).
4. If confusion occurred, add a dated `[Future Tip]` with root cause and correction.

## Purpose Routing (Shared Prompts Library)

- Identify task purpose (for example: `UI_UX`, `Coding`, `Safety_Governance`, `Research`, `Compliance_Regulatory`).
- Attempt to load model-specific purpose guidance from:
  - Codex: `<YOUR_PROJECT_ROOT>/Prompts/categorized/<Purpose>/<Purpose>-Codex.md`
  - Claude: `<YOUR_PROJECT_ROOT>/Prompts/categorized/<Purpose>/<Purpose>-Claude.md`
  - Gemini: `<YOUR_PROJECT_ROOT>/Prompts/categorized/<Purpose>/<Purpose>-Gemini.md`
- If missing, proceed with this file and log a creation recommendation.

## Model Switching Rule

When switching model/tool, include a complete handoff block from:
`LLM_COLLABORATION_SYSTEM/MODEL_SWITCH_HANDOFF_TEMPLATE.md`

## Web Chat Rule

If working in a web LLM without local file access, use:
`LLM_COLLABORATION_SYSTEM/WEB_UPLOAD_GUIDE.md`
