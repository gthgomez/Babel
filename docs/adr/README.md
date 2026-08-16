# Architecture Decision Records — Babel CLI

<!--
status: ACTIVE
last_verified: 2026-08-15
-->
| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-0001](ADR-0001-canonical-public-source.md) | Canonical Public Source | Accepted | 2026-07-22 |
| [ADR-001](ADR-001-four-stage-pipeline.md) | Four-Stage Pipeline Architecture | Accepted | 2026-06-19 |
| [ADR-002](ADR-002-zod-cross-stage-contracts.md) | Zod Cross-Stage Contracts | Accepted | 2026-06-19 |
| [ADR-003](ADR-003-waterfall-routing.md) | Waterfall Routing (`runWithFallback`) | Accepted | 2026-06-19 |
| [ADR-004](ADR-004-stateless-executor-loop.md) | Stateless Executor Loop | Accepted | 2026-06-19 |
| [ADR-005](ADR-005-esm-module-system.md) | ESM Module System | Accepted | 2026-06-19 |
| [ADR-006](ADR-006-interpreter-allowlist.md) | Interpreter Allowlist Approach | Accepted | 2026-06-19 |
| [ADR-007](ADR-007-path-jail-symlink.md) | Path Jail with Symlink Resolution | Accepted | 2026-06-19 |
| [ADR-008](ADR-008-docker-isolation-strategy.md) | Docker Isolation Strategy | Accepted (H3 complete; H4 fail-closed isolation implemented; platform-native backends remain future research) | 2026-06-19 |
| [ADR-009](ADR-009-tui-rendering-paradigm.md) | Hybrid TUI Rendering Paradigm | Accepted | 2026-06-26 |
| [ADR-010](ADR-010-app-server-protocol.md) | App-Server Protocol Contract | Accepted for the protocol contract; runtime transport remains partial | 2026-06-30 |
| [ADR-011](ADR-011-embedding-decision.md) | Optional Embedding Provider with Local FTS Fallback | Implemented — external embeddings are optional and FTS5 remains the local fallback | 2026-07-03 |
| [ADR-012](ADR-012-canonical-harness-architecture-v1.md) | Canonical Harness Architecture v1 | Accepted | 2026-08-03 |
| [ADR-013](ADR-013-h7-model-path-experimental-deferral.md) | H7 Model-Path Factorial Measurement Scope | Accepted (amended same day: model-path cells measured via OpenRouter) | 2026-08-06 |

> **Numbering exception:** ADR-0001 predates the later three-digit ADR sequence and is
> retained to preserve stable history and links. New ADRs continue sequentially after
> ADR-013.

## Status Convention

- **Proposed** — Under discussion, not yet decided
- **Accepted** — Approved and in effect
- **Deprecated** — Still applicable but being replaced by a newer ADR
- **Superseded** — Replaced by a newer ADR; retained for historical context

ADR decision statuses are separate from documentation lifecycle statuses
(`CANONICAL` / `ACTIVE` / `EXPERIMENTAL` / `HISTORICAL` / `SUPERSEDED`); do not substitute
one for the other.

## Writing a New ADR

1. Copy an existing ADR as a template
2. Use the standard sections: Status, Date, Deciders, Context, Decision, Alternatives Considered, Consequences, Compliance
3. Number sequentially after ADR-013
4. Add to this index (exactly one entry per ADR file)
5. Submit for review with the relevant code changes
