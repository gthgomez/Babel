<!--
status: ACTIVE
last_verified: 2026-08-03
architecture_version: harness-v1
-->

# ADR-012 — Canonical Harness Architecture v1

> **Date**: 2026-08-03  
> **Status**: Accepted  
> **Normative specification**: [HARNESS_ARCHITECTURE_V1.md](../architecture/HARNESS_ARCHITECTURE_V1.md)

---

## Context

Babel grew a capable runtime (ChatEngine, plan lane, V9 pipeline, shared executor kernel, verifiers, sandbox profiles, evidence bundles) faster than a single **normative** architecture home. Documentation drifted on:

- daily ChatEngine vs historical Lite/AgentSession framing,
- whether Chat shares the executor kernel,
- Deep mutation vs Full/Spark read-only proof lanes,
- turn limits,
- missing `babel-cli/CLAUDE.md` references,
- implementation vs target (independent verifier, fail-closed isolation, unified evidence).

Without a frozen contract, agents and humans re-discover or accidentally weaken reliability invariants (completion honesty, plan read-only, mode policies).

## Decision

1. Establish **`docs/architecture/HARNESS_ARCHITECTURE_V1.md`** as the sole **normative** runtime harness specification (`architecture_version: harness-v1`).
2. Preserve **three product controllers** (Chat, Plan, Deep) with **shared executor contracts/kernel**, not a single collapsed controller.
3. Keep **Prompt OS** (catalog layers, V9 routing) separate from **harness enforcement** (tools, isolation, completion).
4. Place **completion authority outside model self-report** (`completionGatePolicy` + `kernel.completion.decide`).
5. Enforce the freeze with **conformance tests**, a **golden harness example**, and **`tools/check-harness-architecture.ps1`** drift detection.
6. Resolve package guidance via **`babel-cli/CLAUDE.md`** (concise operational pointer), not a second architecture bible.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Collapse Chat/Plan/Deep into one loop | Loses intentional policy differences (read-only plan, governed deep, interactive chat) |
| Treat ARCHITECTURE.md as harness norm | Mixes Prompt OS with runtime; too easy to lose completion/isolation detail |
| Treat HARNESS_OVERVIEW as normative | Overview should stay short; norms need versioned MUST/SHOULD language |
| Defer until Verifier Kernel v2 ships | Architecture drift continues; improvements lack a frozen baseline |
| Only prose, no tests | Agents ignore docs under pressure |

## Consequences

### Positive

- One authority for harness questions.
- Clear IMPLEMENTED vs TARGET labeling.
- Conformance suite blocks silent policy regressions.
- Golden fixture teaches the intended event sequence without live models.

### Negative / costs

- Doc hierarchy maintenance cost (spec + ADR + overview + checker).
- Some target invariants (H13 fail-closed isolation) are documented as gaps and will fail audit fixtures until implemented.

### Migration

- Mode docs and overview link **to** the normative spec; they MUST NOT claim primary authority.
- Runtime refactors of kernel/completion/sandbox MUST update harness-v1 + tests.

## Open follow-ups (not decided here)

1. Structural verifier identity and directional coverage.  
2. Live revision-bound independent verification in Chat.  
3. Fail-closed governed isolation when Docker unavailable.  
4. Unified hash-linked episode stream.  
5. Held-out promotion verification and model-fixed harness eval.

## Related

- [HARNESS_ARCHITECTURE_V1.md](../architecture/HARNESS_ARCHITECTURE_V1.md)
- [HARNESS_OVERVIEW.md](../architecture/HARNESS_OVERVIEW.md) (explanatory)
- ADR-001–004 (pipeline), ADR-006–008 (isolation)
- `babel-cli/src/executor/architectureConformance.test.ts`
- `examples/golden-harness/`
