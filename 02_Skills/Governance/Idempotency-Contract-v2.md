<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Idempotency Contract (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** v1.0 (compiled min only — this is the first full-source version)
**Pairs with:** `skill_ops_observability` (DESIGN mode), `domain_swe_backend`, `domain_devops`, `ols-compiler` (hardening)
**Activation:** Load for any task that writes operations executed in serverless or edge environments where retries are automatic and unbounded — webhook handlers, queue consumers, scheduled jobs, payment flows, subscription state transitions, or any mutation where "at least once" delivery is the infrastructure default.

---

## Purpose

Serverless and edge platforms retry automatically. A webhook handler that fires twice because of a network hiccup will double-charge a customer, send duplicate emails, or create corrupted state — silently. Without explicit idempotency classification and deduplication, "at least once" delivery becomes "at least once corruption."

This skill codifies a pre-plan idempotency contract: classify every mutating operation, declare deduplication strategies for the non-idempotent ones, and surface retry risks explicitly before code is written.

---

## Step 1 — CLASSIFY EACH OPERATION

| Operation | Class | Key Field(s) | Reason |
|-----------|-------|-------------|--------|
| `[operation]` | [class] | [key field(s)] | [why this classification] |

**Idempotency classes:**

| Class | Definition | Example |
|-------|-----------|---------|
| `NATURAL` | Safe to retry without any key. Identical inputs always produce identical state. | DB upsert on primary key; idempotent DELETE |
| `KEY_GATED` | Idempotent only when an external key is checked before execution. Requires deduplication logic. | Webhook handler using provider event ID |
| `CONDITIONAL` | Safe to retry only if guarded by a precondition check. | UPDATE only if current version matches expected |
| `NON_IDEMPOTENT` | Each execution produces a distinct side effect. Requires exactly-once delivery or deduplication. | Sending email; charging card without idempotency key |

**Rule:** Operations classified `NON_IDEMPOTENT` must have an exactly-once delivery guarantee or a deduplication strategy declared in Step 2. If neither is possible, that constraint must appear in RISKS with explicit acknowledgment — do not ship a NON_IDEMPOTENT operation without documented risk.

---

## Step 2 — DEDUPLICATION STRATEGY

Required for every `KEY_GATED` and `NON_IDEMPOTENT` operation.

| Operation | Strategy | Implementation | Storage | TTL |
|-----------|----------|---------------|---------|-----|

**Deduplication strategies:**

| Strategy | How it works |
|----------|-------------|
| `DB_UNIQUE_CONSTRAINT` | Insert with unique key; catch duplicate key error and return success |
| `DB_UPSERT` | `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` |
| `IDEMPOTENCY_TABLE` | Dedicated table storing processed event IDs with TTL; check before processing |
| `CONDITIONAL_UPDATE` | `UPDATE ... WHERE version = expected` — reject if version mismatch |
| `PROVIDER_KEY` | Use provider-issued idempotency key (Stripe, Svix, GitHub webhook) |
| `HASH_FINGERPRINT` | Hash the request payload; check against recent-processed log before executing |

**Rule for webhook handlers:** Always check the provider event ID before processing. The event ID IS the idempotency key. Never process a webhook body without first verifying the event ID has not been processed.

---

## Step 3 — RETRY SURFACE DECLARATION

| Operation | Retry Context | Max Retries | Backoff | Safe to Retry? |
|-----------|--------------|-------------|---------|----------------|
| `[operation]` | [webhook / queue / scheduled / manual] | [n or unbounded] | [linear / exponential / none] | YES / NO |

**If `Safe to Retry: NO`:** The operation must have a deduplication strategy from Step 2, or must be flagged in RISKS as a non-idempotent risk with accepted business impact.

**If retry context is `unbounded`** (e.g., a queue with no max-retry cap): Treat the operation as subject to infinite retries. Deduplication is mandatory — a key check that fails on the 100th retry is a latent bug, not an edge case.

---

## Idempotency Contract Output

```
IDEMPOTENCY CONTRACT
────────────────────
Operations:
  [table from Step 1 — class and key per operation]

Deduplication:
  [strategy per KEY_GATED / NON_IDEMPOTENT operation]

Retry Surface:
  [retry context and safety status per operation]

Non-Idempotent Risks:
  [any NON_IDEMPOTENT operation with no deduplication — state the accepted risk explicitly]
```

This section must appear in the plan alongside or within the OPERATIONAL section (from `skill_ops_observability` DESIGN mode).

---

## Hard Rules

1. Never classify a webhook handler as `NATURAL`. Webhooks are always `KEY_GATED` at minimum — the provider event ID is the key.
2. Never write a payment or subscription state transition without a deduplication strategy.
3. An operation that calls an external API (email, SMS, charge) is `NON_IDEMPOTENT` unless the API provider offers an idempotency key and you use it.
4. DB upserts are `NATURAL` only if the upsert key matches the logical identity of the record. A upsert on `email` is NATURAL; a upsert on a surrogate `id` without a unique constraint on the business key is NOT.
5. If exactly-once delivery is required but the infrastructure does not provide it, the constraint must appear in RISKS with explicit acknowledgment. Do not assume at-most-once delivery in an at-least-once environment.
6. **New in v2.0:** Deduplication storage (IDEMPOTENCY_TABLE, HASH_FINGERPRINT log) must have a TTL. Infinite storage for dedup keys is a slow resource leak. Default TTL: 30 days for payment events, 7 days for webhooks.
7. **New in v2.0:** Every NON_IDEMPOTENT operation accepted as a documented risk must have a compensating transaction or manual recovery runbook. "We accept the risk" without a recovery path is not operational readiness.

---

## Boundaries — Do Not Overstep

- **This skill classifies and deduplicates operations — it does not implement them.** The idempotency contract is a design artifact. Implementation lives in code (unique constraints, upsert logic, idempotency tables).
- **This skill does not replace database transaction isolation.** Idempotency prevents duplicate side effects. Transactions prevent partial side effects. Both are needed; neither replaces the other.
- **This skill does not guarantee exactly-once delivery.** It guarantees that at-least-once delivery does not produce duplicate side effects. The distinction matters for messaging semantics.
- **This skill complements ops-observability DESIGN mode.** The OPERATIONAL section defines logging/recovery; the IDEMPOTENCY CONTRACT defines deduplication. They are sibling plan sections, not replacements.

---

## Failure Behavior of This Skill

- **Operation's idempotency class is genuinely ambiguous:** Default to the stricter class. If NATURAL vs KEY_GATED is unclear → classify as KEY_GATED. Over-classification is safe (extra dedup check); under-classification is dangerous (duplicate side effect).
- **No deduplication strategy is feasible for a NON_IDEMPOTENT operation:** Flag as CRITICAL RISK. The operation cannot be safely deployed in an at-least-once environment. Recommend architectural change (add an idempotency key, use a provider with idempotency support, or split the operation).
- **Retry context is unknown (new platform, unfamiliar queue):** Assume `unbounded`. Treat as worst-case. Research the actual retry behavior before downgrading the assumption.
- **Self-test:** The idempotency contract should be tested by simulating duplicate delivery of each classified operation and verifying the deduplication strategy prevents double side effects.

---

## Strategic Next Move

After every IDEMPOTENCY CONTRACT, end with exactly one strategic next-move question: if NON_IDEMPOTENT risks exist, ask whether to redesign the operation or accept the risk with a documented recovery path.

---

## References

- `skill_ops_observability` (`02_Skills/Governance/Ops-Observability-v2.md`) DESIGN mode — produces the OPERATIONAL section that the IDEMPOTENCY CONTRACT sits alongside.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening deduplication strategies against discovered edge cases.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for auditing idempotency contract completeness.

---

**Design note:** This v2.0 is the first full-source version of the idempotency contract skill. It preserves the v1.0 3-step workflow and 4-class taxonomy, and adds OLS-MCC v4.2 compliance: Boundaries, Failure Behavior (4 scenarios), Strategic Next Move, dedup storage TTL requirement, compensating transaction mandate for accepted risks, and handoff to ops-observability and the meta layer.
