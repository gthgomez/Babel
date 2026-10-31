<!--
status: ACTIVE
last_verified: 2026-08-05
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
   Verified execute completion also requires the current frozen acceptance head and private criterion evidence (`authority/criterionCompletion.ts`). The fail-closed kernel connection is implemented; trusted binding, execution and durable evidence publication remain incomplete, so required criteria cannot yet reach live verified completion.
5. Enforce the freeze with **conformance tests**, a **golden harness example**, and **`tools/check-harness-architecture.ps1`** drift detection.
6. Resolve contributor policy via **`AGENTS.md`** and package implementation facts via **`babel-cli/PROJECT_CONTEXT.md`**; neither duplicates harness norms.
7. Use one validated, hash-linked `episode-events.jsonl` producer per Chat/pipeline run. Pipeline episode persistence is supplemental to the authoritative `EvidenceBundle`, reports degradation, and fails closed on invalid resume/quarantine boundaries. This remains **PARTIAL** until phase instrumentation, offline integration, and full-suite release gates are green.
8. Give each Chat submission one monotonic `RunControl` bound to existing run/turn/generation identities. It owns continuation only; durable admission, permissions and completion retain their current owners. Recheck at every physical tool/provider start after suspension, including retries and compaction. Preserve settlement of already-started work under its original owner. Typed host stops replace tool-prose control. A mutable shared abort controller alone cannot fence approval races or prevent a new session from resetting old terminal state; this small latch adds no persisted identity or parallel completion evaluator.

## Approved CLI/provider coherence amendment (2026-10-30)

The preferred `--headless` flag changes presentation after workflow resolution;
it MUST NOT select Work over a saved Plan or grant execution permissions. The
advanced literal `chat-headless` lane retains its existing compatibility contract.

The three internal controllers remain distinct. Public Work maps to Chat; Plan
MUST stop after producing its read-only handoff unless a trusted user-owned
`plans.autoApply` preference explicitly enables the implementation transition.
Explicit plan-only intent and existing read-only authority MUST override that
preference. Apply MUST bind the saved plan to project identity and source freshness,
serialize application, and retain current budgets, isolation and kernel authority.
No new completion evaluator is introduced.

A fresh profile MUST NOT select a cloud provider/model from installed keys or model
substrings. The private user settings resolver owns connection selection and its
provenance across CLI and TUI. Repository content MUST NOT choose credential
sources or endpoints. ProviderEngine owns adapter construction; protocol sharing
MUST live under a neutral protocol owner. Vendor files retain vendor wire details.
Automatic cross-provider fallback is forbidden for an explicitly selected connection.
Native tool events MUST pass through existing Babel tool authorization, execution,
accounting and completion. Unsupported operations remain visible and fail closed.

Persisted `preferences.json` and saved plan records use schema version 1 with
validation before atomic replacement. Existing harness event IDs and completion
schemas remain unchanged; optional `reason_detail` refines presentation without
changing terminal authority. Legacy manual plan/recovery interfaces retain their
effects. The unambiguous new conversation namespace is `conversation list/resume`;
CLI `session` remains evidence inspection for compatibility. See the
[approved design](../superpowers/specs/2026-10-30-cli-backend-coherence-design.md).

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
- Architecture follow-ups require coordinated contract, implementation, conformance, and documentation updates as they move from target to implemented.

### Migration

- Mode docs and overview link **to** the normative spec; they MUST NOT claim primary authority.
- Runtime refactors of kernel/completion/sandbox MUST update harness-v1 + tests.

## Open follow-ups (not decided here)

Structural verifier identity, Chat revision binding, fail-closed governed isolation, high-assurance IndependentVerifier defaults, and core episode producers landed after this ADR was accepted. Remaining hardening work and measurable exit gates are sequenced in the [Harness Hardening Roadmap v1](../architecture/HARNESS_HARDENING_ROADMAP_V1.md).

## Related

- [HARNESS_ARCHITECTURE_V1.md](../architecture/HARNESS_ARCHITECTURE_V1.md)
- [HARNESS_HARDENING_ROADMAP_V1.md](../architecture/HARNESS_HARDENING_ROADMAP_V1.md) (canonical implementation sequence)
- [HARNESS_OVERVIEW.md](../architecture/HARNESS_OVERVIEW.md) (explanatory)
- ADR-001–004 (pipeline), ADR-006–008 (isolation)
- `babel-cli/src/executor/architectureConformance.test.ts`
- `examples/golden-harness/`
