# Source ownership map

<!--
status: ACTIVE
last_verified: 2026-11-18
-->

> **Role**: durable ownership map for the CLI source tree and the rules for changing it. Contributor policy is owned by root [AGENTS.md](../../AGENTS.md); this page records architecture responsibility only. It is not a release qualification, a merge authorization, or a second agent rulebook.

## Why this exists

The 2026-11 six-audit register (issue #521, findings AR-01 and AR-04) observed that large, frequently edited orchestration modules make it hard to tell which change owner is responsible for a behavior. The response is not a directory shuffle. It is an explicit, machine-checked map:

- [`config/architecture-ownership.json`](../../config/architecture-ownership.json) is the single source of truth. Every top-level entry under `babel-cli/src/` (directories and non-test root modules) must appear in exactly one component.
- `npm --prefix babel-cli run test:harness-acceptance` (`src/executor/architectureConformance.test.ts`) fails when a top-level module is unowned, owned twice, or points at a missing path.
- Components name a responsibility, not a person. Individual reviewers, issues and PRs stay in GitHub; the map answers "whose contract is this?".

## Components

The manifest is authoritative; this table is a reading aid.

| Component | Primary surface | Responsibility |
| --- | --- | --- |
| `entrypoints` | `src/index.ts`, `src/cliMain.ts`, `src/commands/`, `src/daemon/`, `src/lite/` | Process entry, dispatch, command registration, daemon/lite startup |
| `agent-runtime` | `src/agent/`, `src/taskCompletion.ts` | ChatEngine loop, task admission, tool proposal glue, completion-gate policy |
| `completion-kernel` | `src/executor/`, `src/stages/`, `src/authority/` | Mode-neutral contracts, `completion.decide`, effects, verifier stages, criterion authority |
| `orchestration` | `src/pipeline.ts`, `src/pipeline/`, `src/orchestrator/` | Governed deep pipeline, stage sequencing, checkpoints, rollback |
| `runtime-state` | `src/runtime/`, `src/protocol/`, `src/evidence.ts` | Run control, event projection, recovery/restore, evidence recording |
| `tool-surface` | `src/tools/`, `src/mcp/`, `src/bridge/`, `src/localTools.ts` | Tool catalog, adapters, MCP bridge, shell output normalization |
| `sandbox-process` | `src/sandbox*.ts`, `src/processTree.ts`, `src/portable/` | Sandbox profiles, container lifecycle, file-write boundary, process termination |
| `interaction-ui` | `src/ui/`, `src/interactive/`, `src/interactive.ts` | TUI rendering, input ownership, REPL/session UX, transcript presentation |
| `prompt-stack` | `src/compiler.ts`, `src/routingEngine.ts`, `src/modelPolicy.ts`, `src/control-plane/` | Resolver/compiler, catalog parsing, routing, model policy, research/search ingestion |
| `domain-services` | `src/services/` | Shared service layer (review/readiness, workspace transactions, verifier contracts, maintenance audits) |
| `execution-eval` | `src/execute.ts`, `src/eval/`, `src/acceptance/`, budgets | Execute-mode entry, evaluation, calibration, budgets, acceptance fixtures |
| `diagnostics` | `src/doctor.ts`, `src/diagnostics/`, `src/audit/`, `src/inspect/` | Doctor checks, diagnostic streams, BDNS observation, repository audits |
| `providers` | `src/runners/`, `src/claude-babel-astra-lab/` | Provider adapters and request/response translation |
| `telemetry` | `src/telemetry/`, `src/voice/` | OpenTelemetry spans and voice I/O |
| `config-schemas` | `src/config/`, `src/schemas/` | Runtime configuration resolution and shared schemas |
| `shared-utils` | `src/utils/` | Small dependency-free helpers |
| `test-infrastructure` | `src/testinfra/`, `src/testUtils/`, `src/test-helpers/`, `src/testing/` | Harness isolation, fixtures and test helpers |

## Hot paths and their boundaries

These modules are both large and frequently edited. Size alone is not a defect; the boundary rule is what keeps them reviewable.

| Path | Boundary rule |
| --- | --- |
| `babel-cli/src/agent/chatEngine.ts` | Owns the daily loop. Admission decisions belong to `taskAcceptance*`; terminal truth belongs to `executorKernel.completion.decide`; tool effects belong to the tool catalog. Do not add a second completion decision or a private tool table here. |
| `babel-cli/src/pipeline.ts` | Owns stage sequencing and handoff. Stage prompts, verifier contracts and effect classification live in their owning modules; the pipeline must not re-implement them. |
| `babel-cli/src/pipeline/executorLoop.ts` | Owns governed iteration and checkpoint/recovery wiring. Completion authority stays in the kernel. |
| `babel-cli/src/executor/kernel.ts` | Sole owner of the terminal completion decision under harness-v1. Changes here are contract changes and need the completion owner review. |
| `babel-cli/src/ui/waterfall.ts`, `src/ui/rendererSupport.ts`, `src/ui/conversationalRenderer.ts` | Own the live output path. Raw stdout/exit calls require a grant in `config/architectural-budget/process-boundaries.json`. |
| `babel-cli/src/services/liveCliReliabilityMatrix.ts` | Measurement surface; it may orchestrate checks but must not become runtime authority. |

## Duplicate and dead sources

- One module, one implementation. A `.js` file must not shadow a `.ts` twin. TypeScript is the only compiled source (`npm run build` emits the `.ts` implementation), so a shadowed `.js` file is dead weight that also confuses dead-code tooling. The conformance suite enforces this; `babel-cli/source-provenance.json` lists the intentional JavaScript-only sources that have no TypeScript twin.
- `npm --prefix babel-cli run knip` uses `babel-cli/knip.json` with real entry points (CLI, daemon, workers, test-workers, tests, scripts). Without that file the default scan reports whole categories of live UI modules as unused.
- `npm --prefix babel-cli run check:dead-code` is a non-regression ratchet over that report. Known unreferenced modules are listed in [`config/architectural-budget/unused-modules.json`](../../config/architectural-budget/unused-modules.json); new ones fail the check. The baseline is debt, not approval: deleting an entry requires evidence that the module is unreachable from every entry point. The 24-entry set is a post-removal product (the file was introduced after the shadowed `.js` removal); its entries were individually rechecked against base `90583d97`.
- `babel-cli/src/security-audit-report.json` is a dated (2026-08-30) historical audit artifact that still cites the removed `src/ui/theme.js` and `src/ui/waterfall.js` line numbers. It is retained unmodified as evidence, not as a live source map. Its theme/ANSI content still describes the live `theme.ts` (same CSI-SGR-only `stripAnsi`), and its waterfall EPIPE site now lives in `rendererSupport.ts`/`outputBuffer.ts`. Do not treat its paths as current ownership.

## Import graph

At `90583d97`, `npm --prefix babel-cli run audit:import-graph` scans 2,802 TypeScript modules: 10,172 static relative edges (including `import type`) and 8,271 value edges that survive type erasure. It finds **22 source-level cycles and 18 value-level cycles**. The largest value cycle spans 18 modules across `src/commands/`, `src/interactive/`, `src/services/` and `src/ui/`; the next spans 6 agent session-event modules. This reproduces the cycle element of AR-01 rather than disproving it — the cycles do cross command, task, tool, evidence and UI responsibilities. The scan covers static `import`/`export … from` and literal `import()` edges; it does not model runtime path strings or worker spawning. Breaking these cycles is a behavior-affecting refactor owned by the affected streams, and no per-stream split was attempted here; the measurement is recorded so a future baseline gate can be honest about the starting point.

## Changing ownership

1. Add or move the module.
2. Update `config/architecture-ownership.json` in the same change. Do not leave a module unowned.
3. Run `npm --prefix babel-cli run test:harness-acceptance`.
4. If the change touches a hot path, name the contract owner in the PR description and keep the boundary table above accurate.

Cross-stream campaign ownership (which workstream owns which finding) is separate: see [AUDIT_RECONCILIATION.md](./AUDIT_RECONCILIATION.md).
