# Babel Architecture Documentation Index

<!--
status: ACTIVE
last_verified: 2026-08-15
-->

> **Role**: Architecture guides, layer model specifications, and execution contract documentation for Babel.

## Canonical / Normative

| Document | Description |
| :--- | :--- |
| [**HARNESS_ARCHITECTURE_V1.md**](./HARNESS_ARCHITECTURE_V1.md) | **Normative** runtime harness specification (`harness-v1`). Authority: canonical. The single runtime-harness authority. |
| [**HARNESS_HARDENING_ROADMAP_V1.md**](./HARNESS_HARDENING_ROADMAP_V1.md) | **Canonical implementation roadmap** under harness-v1: H0–H7 sequencing and exit gates. Subordinate to harness-v1. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | **Prompt OS + system architecture**: six layers, catalog, router, kernel headline. Owns the Prompt OS layer model; must not redefine runtime invariants. |
| [CLI_COMMAND_CONTRACT.md](../CLI_COMMAND_CONTRACT.md) | **Canonical user-facing CLI command contract.** |

## Active Explanatory / Reference

| Document | Description |
| :--- | :--- |
| [HARNESS_OVERVIEW.md](./HARNESS_OVERVIEW.md) | Explanatory harness map (not normative — never overrides harness-v1). |
| [RUNTIME_MODES.md](./RUNTIME_MODES.md) | Runtime use vs instruction-only use, sessions, execution profiles. |
| [STAGE_MODEL_POLICY.md](./STAGE_MODEL_POLICY.md) | Stage waterfalls, eligibility vs reordering, policy location. Mutable roster truth: `config/model-policy.json`. |
| [REPO_LOCAL_INSTRUCTION_PRECEDENCE.md](./REPO_LOCAL_INSTRUCTION_PRECEDENCE.md) | Babel vs repo-local instruction surfaces. |
| [SKILL_SYSTEM_BRIDGE.md](./SKILL_SYSTEM_BRIDGE.md) | Prompt skills (`02_Skills/`) vs package-style skills (`skills/`). |
| [SKILL_SELECTION_AND_DOMAIN_DEFAULTS.md](./SKILL_SELECTION_AND_DOMAIN_DEFAULTS.md) | Domain default skill expansion; `prompt_catalog.yaml` sole catalog. |
| [BABEL_OTEL_SCHEMA-v1.md](./BABEL_OTEL_SCHEMA-v1.md) | OpenTelemetry span schema for governed runs. |
| [MCP_Adapter-v1.md](./MCP_Adapter-v1.md) | MCP control-plane adapter (read-only/introspection boundary). |
| [OPERATOR_STATUS_TAXONOMY.md](../guides/OPERATOR_STATUS_TAXONOMY.md) | Doctor / env operator status codes. |
| [MULTI_AGENT_ORCHESTRATION.md](./MULTI_AGENT_ORCHESTRATION.md) | Bounded agent teams (`babel agents`) — **EXPERIMENTAL**, non-normative. |
| [PORTABLE_WORKFLOW_CONTRACT.md](../guides/PORTABLE_WORKFLOW_CONTRACT.md) | Portable workflow contract; non-normative, subordinate to `harness-v1`. |
| [CHAT_MODE.md](../CHAT_MODE.md) | Default daily ChatEngine product path. |

## Related ADRs

All decisions: [docs/adr/README.md](../adr/README.md). Pipeline and isolation decisions:
`ADR-001`–`ADR-004`, `ADR-006`–`ADR-008`, `ADR-010`; harness freeze: `ADR-012`; model-path
measurement scope: `ADR-013`.

## Historical / Archived

Retired product/architecture documents live in [docs/archive/architecture/](../archive/architecture/)
(`BABEL_LITE.md`, `BABEL_FULL_ORCHESTRATION.md`, `ROUTER_PLATFORM_FIELDS.md`). They are
preserved for history and are **not** live architectural documentation. Lifecycle statuses
on archived files (`SUPERSEDED` / `HISTORICAL`) state intent; see
[docs/archive/README.md](../archive/README.md).
