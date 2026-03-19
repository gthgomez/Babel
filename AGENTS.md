# AGENTS.md - Babel Antigravity Router

Purpose: quick startup and safe navigation for Babel.

## Read Order

1. `..\PROJECT_SAAS_BIBLE.md`
2. `BABEL_BIBLE.md`
3. `PROJECT_CONTEXT.md`
4. This file
5. Relevant files in `.agents/rules/`
6. Relevant files in `.agents/skills/`

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

## What This Repo Is

Babel is the prompt operating system for the wider workspace. It assembles the smallest correct instruction stack from behavioral layers, domain architects, skills, adapters, and overlays.

## Antigravity Layout

- `.agents/rules/` - stable Babel boundaries and protected contracts
- `.agents/skills/` - reusable workflows for stack assembly and control-plane validation
- `GEMINI.md` - lean Gemini operating style for this repo

## High-Risk Zones

- `00_System_Router/`
- `01_Behavioral_OS/`
- `prompt_catalog.yaml`
- `babel-cli/src/pipeline.ts`
- `babel-cli/src/compiler.ts`
- `babel-cli/src/schemas/agentContracts.ts`
- `tools/resolve-control-plane.ps1`

## Non-Negotiables

- Keep the v9 router as the default typed lane and v8 as the compatibility fallback.
- Preserve the separation between Behavioral OS, Domain Architects, and Skills.
- Treat edits to `01_Behavioral_OS/` as global breaking changes.
- Keep `prompt_catalog.yaml` as the canonical registry.

## Quick Commands

```powershell
npm --prefix .\babel-cli run typecheck
npm --prefix .\babel-cli run build
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-control-plane.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-sync-model-manifests.ps1
```

## How To Work Here

- Read `.agents/rules/02-control-plane-boundaries.md` before changing routers, behavioral rules, catalog entries, or compiled-memory tooling.
- Read `.agents/rules/03-execution-and-verification.md` for all non-trivial work.
- Read `.agents/rules/04-context-loading-and-contract-safety.md` before changing prompt contracts, compiler behavior, or compatibility outputs.
- Use the stack-assembly skill when the task is about selecting Babel layers.
- Prefer the smallest correct instruction stack over adding new layers.
