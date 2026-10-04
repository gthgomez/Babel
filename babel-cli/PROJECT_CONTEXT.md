# PROJECT_CONTEXT.md - Babel CLI

## What This Is

Authoritative TypeScript/Node.js CLI package for the canonical public Babel prompt
OS runtime. `src/` is source; `dist/` is generated output; `bin/babel.js` launches
`dist/index.js`.

This file is the agent-neutral package-local context. The repository-root
`PROJECT_CONTEXT.md`, `INTEGRATION.md`, and `prompt_catalog.yaml` remain
authoritative for Babel-wide control-plane rules.

## Reference scope

This is a non-authoritative implementation map, not contributor instructions.
Root [AGENTS.md](../AGENTS.md) owns contributor policy. [README.md](README.md)
contains CLI command examples; [INTEGRATION.md](../INTEGRATION.md) and the catalog
explain Babel stack assembly. Consumer-local instructions remain external inputs.

## Architecture & Invariants

- `src/` is the only source tree for active CLI implementation.
- `dist/` is generated build output.
- `runs/` contains runtime evidence and local outputs.
- `source-provenance.json` tracks approved `.js` source provenance debt.
- Prompt catalog and runtime contract changes can affect the whole Babel system.
- Remote-mutating CLI commands use the runtime authority gates.

### Runtime harness references

| Document | Role |
|----------|------|
| `../docs/architecture/HARNESS_ARCHITECTURE_V1.md` | **Normative** harness architecture (`harness-v1`) |
| `../docs/architecture/HARNESS_OVERVIEW.md` | Explanatory map only |
| `../docs/adr/ADR-012-canonical-harness-architecture-v1.md` | Decision record |
| `../examples/golden-harness/` | Golden + negative fixtures |
| `../tools/check-harness-architecture.ps1` | Drift checker |
| `src/executor/architectureConformance.test.ts` | Conformance tests |

| Concern | Primary paths under `src/` |
|---------|----------------------------|
| Daily loop | `agent/chatEngine.ts`, `interactive/execution/chatCore.ts` |
| Completion honesty | `agent/completionGatePolicy.ts`, `executor/kernel.ts` |
| Terminal outcomes | `schemas/agentContracts.ts` (`TerminalOutcome`), `agent/chatEngineObservability.ts` |
| Mode policy / effects | `executor/contracts.ts` |
| Governed pipeline | `pipeline.ts`, `pipeline/executorLoop.ts` |
| Sandbox / profiles | `sandbox.ts`, `config/executionProfiles.ts` |
| Worktree safety | `services/worktreeSafety.ts`, `services/workspaceTransactions.ts` |
| Required verifiers (pipeline) | `services/requiredVerifierContract.ts` |
| BDNS observation | `diagnostics/bdns/` (subordinate to `docs/architecture/BDNS_ARCHITECTURE_V1.md`) |
| Executable acceptance (local experimental recording) | `acceptance/` (subordinate to `docs/architecture/EXECUTABLE_ACCEPTANCE_V0.md`; must not change kernel completion in V0) |

`executorKernel.completion.decide` implements terminal honesty for execute modes under harness-v1. The source map is explanatory; harness-v1 owns runtime norms.

For additional source and ownership pointers, consult the explanatory
[HARNESS_OVERVIEW.md](../docs/architecture/HARNESS_OVERVIEW.md) when relevant.
Architectural size, cast, output, and exit budgets live in the committed
[baselines](../config/architectural-budget/) and are checked by
[check-architectural-budget.ps1](../tools/check-architectural-budget.ps1).
Repository and CI locations are mapped in [STRUCTURE.md](../STRUCTURE.md).

## Verification & Commands

Run from `.\babel-cli`.

- Install: `npm ci`
- Type check: `npm run typecheck`
- Build: `npm run build`
- Unit/regression suite: `npm test`
- Release-readiness benchmark: `npm run benchmark:readiness`
- Dist cleanliness: `npm run check:dist`
- Source provenance: `npm run check:source-provenance`

Verification selection is governed by root AGENTS.md; these are package command references.

## Risk Zones

- `src/pipeline.ts`, executor stages, and checkpoint/recovery logic.
- `src/compiler.ts`, resolver/catalog handling, and manifest generation.
- `src/schemas/agentContracts.ts` and runtime artifact contracts.
- CLI command registration and argument parsing.
- Runtime plugin, MCP, schedule, git draft, and subagent team surfaces.
