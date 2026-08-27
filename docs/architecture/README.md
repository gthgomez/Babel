# Babel Architecture Documentation Index

<!--
status: ACTIVE
last_verified: 2026-08-05
-->

> **Role**: Architecture guides, layer model specifications, and execution contract documentation for Babel.

## Start here (agents)

| Document | Description |
| :--- | :--- |
| [**HARNESS_ARCHITECTURE_V1.md**](./HARNESS_ARCHITECTURE_V1.md) | **Normative** runtime harness specification (`harness-v1`). Authority: canonical. |
| [HARNESS_HARDENING_ROADMAP_V1.md](./HARNESS_HARDENING_ROADMAP_V1.md) | **Canonical implementation roadmap** under harness-v1: H0–H7 sequencing and exit gates. |
| [HARNESS_OVERVIEW.md](./HARNESS_OVERVIEW.md) | **Explanatory** short map — defers to V1. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | **Prompt OS + system architecture**: six layers, catalog, V9 router, kernel headline. |
| [../CHAT_MODE.md](../CHAT_MODE.md) | Default daily ChatEngine product path. |
| [../guides/PORTABLE_AGENT_WORKFLOW_PLAN.md](../guides/PORTABLE_AGENT_WORKFLOW_PLAN.md) | Proposed portable workflow contract; non-normative and subordinate to `harness-v1`. |
| [../adr/ADR-012-canonical-harness-architecture-v1.md](../adr/ADR-012-canonical-harness-architecture-v1.md) | Decision record for harness-v1 freeze. |

## Live architectural documentation

| Document | Description |
| :--- | :--- |
| [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) | **Normative harness contract** (modes, authority, invariants, gaps). |
| [HARNESS_HARDENING_ROADMAP_V1.md](./HARNESS_HARDENING_ROADMAP_V1.md) | Canonical hardening sequence, research reconciliation, dependencies, and promotion gates. |
| [BDNS_ARCHITECTURE_V1.md](./BDNS_ARCHITECTURE_V1.md) | Babel Debugging Nervous System contract: bounded independent observation, provenance, privacy, and merge sequence. |
| [BDNS_INVENTORY_V1.md](./BDNS_INVENTORY_V1.md) | B0 inventory of process, workspace, evidence, diagnostic, TUI, and OTel boundaries. |
| [BDNS_FAULT_MATRIX_V1.md](./BDNS_FAULT_MATRIX_V1.md) | Seeded fault diagnosis matrix and differential-value acceptance evidence. |
| [BDNS_HARDENING_V1.md](./BDNS_HARDENING_V1.md) | B8 bounded-soak, privacy, storage, portability, and enablement gates. |
| [EXECUTABLE_ACCEPTANCE_V0.md](./EXECUTABLE_ACCEPTANCE_V0.md) | Proposed Executable Acceptance V0 campaign: patch-blind claims, sufficiency, and blinded experiment. Non-normative; subordinate to harness-v1. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level system architecture, layer model, router contracts, kernel. |
| [HARNESS_OVERVIEW.md](./HARNESS_OVERVIEW.md) | Explanatory harness map (not normative). |
| [BABEL_LOCAL_MODE.md](./BABEL_LOCAL_MODE.md) | Local workspace surfaces, session lifecycle, editor integrations. |
| [BABEL_FULL_ORCHESTRATION.md](./BABEL_FULL_ORCHESTRATION.md) | Full/Spark multi-agent product lane and proof gates (distinct from pipeline `deep` mutation path — see harness overview). |
| [BABEL_LITE.md](./BABEL_LITE.md) | Lite session model (**status: STALE** — prefer [../CLI_COMMAND_CONTRACT.md](../CLI_COMMAND_CONTRACT.md) + ChatEngine docs). |
| [BABEL_CLI_STAGE_WATERFALLS.md](./BABEL_CLI_STAGE_WATERFALLS.md) | Per-stage model waterfalls ↔ `model-policy.json`. |
| [operator-status-taxonomy.md](./operator-status-taxonomy.md) | Doctor / env operator status codes. |
| [BABEL_OTEL_SCHEMA-v1.md](./BABEL_OTEL_SCHEMA-v1.md) | OpenTelemetry span schema for governed runs. |
| [MCP_Adapter-v1.md](./MCP_Adapter-v1.md) | MCP control-plane adapter. |
| [SKILL_SYSTEM_BRIDGE.md](./SKILL_SYSTEM_BRIDGE.md) | Prompt skills vs package skills. |
| [SKILL_CATALOG_AND_DOMAIN_DEFAULTS.md](./SKILL_CATALOG_AND_DOMAIN_DEFAULTS.md) | Domain default skill expansion. |
| [ROUTER_PLATFORM_FIELDS.md](./ROUTER_PLATFORM_FIELDS.md) | Platform routing fields. |
| [BABEL_PROJECT_SYSTEM_INTEGRATION.md](./BABEL_PROJECT_SYSTEM_INTEGRATION.md) | Babel vs repo-local collaboration systems. |
| [babel-remote/BABEL_REMOTE_STAGE0_COVERAGE.md](./babel-remote/BABEL_REMOTE_STAGE0_COVERAGE.md) | Babel Remote Stage 0 vendor coverage and GO/NO_GO. |

## Related ADRs

Pipeline and isolation decisions: `docs/adr/ADR-001` through `ADR-004`, `ADR-006`–`ADR-008`, `ADR-010`.

## Archived architecture docs

Historical spikes, process audits, and monolith rescope analysis are archived in the historical development repository and not included in this public release.
