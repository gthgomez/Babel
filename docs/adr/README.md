# Architecture Decision Records — Babel CLI

<!--
status: ACTIVE
last_verified: 2026-07-21
-->
| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-001](ADR-001-four-stage-pipeline.md) | Four-Stage Pipeline Architecture | Accepted | 2026-06-19 |
| [ADR-002](ADR-002-zod-cross-stage-contracts.md) | Zod Cross-Stage Contracts | Accepted | 2026-06-19 |
| [ADR-003](ADR-003-waterfall-routing.md) | Waterfall Routing (`runWithFallback`) | Accepted | 2026-06-19 |
| [ADR-004](ADR-004-stateless-executor-loop.md) | Stateless Executor Loop | Accepted | 2026-06-19 |
| [ADR-005](ADR-005-esm-module-system.md) | ESM Module System | Accepted | 2026-06-19 |
| [ADR-006](ADR-006-interpreter-allowlist.md) | Interpreter Allowlist Approach | Accepted | 2026-06-19 |
| [ADR-007](ADR-007-path-jail-symlink.md) | Path Jail with Symlink Resolution | Accepted | 2026-06-19 |
| [ADR-008](ADR-008-docker-isolation-strategy.md) | Docker Isolation Strategy | Accepted (H3 done, H4 planned, H6 future) | 2026-06-19 |
| [ADR-009](ADR-009-tui-rendering-paradigm.md) | Hybrid TUI Rendering Paradigm | Accepted | 2026-06-26 |
| [ADR-010](ADR-010-app-server-protocol.md) | App Server Protocol Contract | Accepted | 2026-07-01 |
| [ADR-011](ADR-011-embedding-decision.md) | Local Vector Embeddings Decision | Accepted | 2026-07-05 |

## Status Convention

- **Proposed** — Under discussion, not yet decided
- **Accepted** — Approved and in effect
- **Deprecated** — Still applicable but being replaced by a newer ADR
- **Superseded** — Replaced by a newer ADR; retained for historical context

## Writing a New ADR

1. Copy an existing ADR as a template
2. Use the standard sections: Status, Date, Deciders, Context, Decision, Alternatives Considered, Consequences, Compliance
3. Number sequentially (ADR-009, ADR-010, ...)
4. Add to this index
5. Submit for review with the relevant code changes
