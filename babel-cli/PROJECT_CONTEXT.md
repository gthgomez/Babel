# PROJECT_CONTEXT.md - Babel CLI

## What This Is

Authoritative TypeScript/Node.js CLI package for the canonical public Babel prompt
OS runtime. `src/` is source; `dist/` is generated output; `bin/babel.js` launches
`dist/index.js`.

This file is the agent-neutral package-local context. The repository-root
`PROJECT_CONTEXT.md`, `BABEL_BIBLE.md`, and `prompt_catalog.yaml` remain
authoritative for Babel-wide control-plane rules.

## Startup Sequence

From `babel-cli/`:

1. Read `..\BABEL_BIBLE.md`.
2. Read `..\PROJECT_CONTEXT.md`.
3. Read `..\README.md`.
4. Read `..\prompt_catalog.yaml`.
5. Read this file.
6. Read `README.md` for package command examples and CLI workflows.

Consumer repositories may add their own `AGENTS.md`, engineering standards, or
project context. Those files govern work in that consumer and are not required by
a clean Babel clone.

## Architecture & Invariants

- `src/` is the only source tree for active CLI implementation.
- `dist/` is generated output. Do not hand-edit `dist/`.
- `runs/` contains runtime evidence and local outputs. Do not clean it without explicit user approval.
- `source-provenance.json` tracks approved `.js` source provenance debt.
- Prompt catalog and runtime contract changes can affect the whole Babel system.
- CLI commands that push, deploy, create PRs, or mutate remote state must remain gated.

## Verification & Commands

Run from `.\babel-cli`.

- Install: `npm ci`
- Type check: `npm run typecheck`
- Build: `npm run build`
- Unit/regression suite: `npm test`
- Release-readiness benchmark: `npm run benchmark:readiness`
- Dist cleanliness: `npm run check:dist`
- Source provenance: `npm run check:source-provenance`

Prefer targeted tests for small changes; full `npm test` can be broader.

## Risk Zones

- `src/pipeline.ts`, executor stages, and checkpoint/recovery logic.
- `src/compiler.ts`, resolver/catalog handling, and manifest generation.
- `src/schemas/agentContracts.ts` and runtime artifact contracts.
- CLI command registration and argument parsing.
- Runtime plugin, MCP, schedule, git draft, and subagent team surfaces.
