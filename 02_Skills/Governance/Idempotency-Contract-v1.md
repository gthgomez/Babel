<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Idempotency Contract (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_devops`
**Activation:** Load this skill for any task that writes operations executed in serverless or edge
environments, handles webhooks or queue messages, or involves operations that will or can be retried.

---

## Purpose

In serverless and edge environments, functions are ephemeral, cold starts occur, and at-least-once
delivery is the default for webhooks and queues. An operation is idempotent if executing it multiple
times has the same effect as executing it once.

Non-idempotent operations in retry-capable environments produce duplicate side effects: double
charges, duplicate records, repeated notifications, and inconsistent state. This skill enforces
idempotency classification and contract requirements before any operation is written.

---

## Step 1 — CLASSIFY EACH OPERATION

For every mutation in the plan's MINIMAL ACTION SET, assign an idempotency class:

| Operation | Class | Key | Notes |
|-----------|-------|-----|-------|
| `[operation]` | [class] | [key field(s)] | [reason] |

**Idempotency classes:**

| Class | Definition | Example |
|-------|-----------|---------|
| `NATURAL` | Safe to retry without any key. Identical inputs always produce identical state. | DB upsert on primary key; idempotent DELETE |
| `KEY_GATED` | Idempotent only when an external key is checked before execution. Requires deduplication logic. | Webhook handler using provider event ID |
| `CONDITIONAL` | Safe to retry only if guarded by a precondition check. | UPDATE only if current version matches expected version |
| `NON_IDEMPOTENT` | Each execution produces a distinct side effect. Requires exactly-once delivery or deduplication. | Sending an email; charging a card without an idempotency key |

**Rule:** Operations classified `NON_IDEMPOTENT` must have an exactly-once delivery guarantee or a
deduplication strategy declared in Step 2. If neither is possible, that constraint must appear in
RISKS.

---

## Step 2 — DEDUPLICATION STRATEGY

Required for every `KEY_GATED` and `NON_IDEMPOTENT` operation.

| Operation | Strategy | Key Source | Storage | TTL |
|-----------|----------|-----------|---------|-----|
| `[operation]` | [strategy] | [where the key comes from] | [where it is stored] | [expiry] |

**Deduplication strategies:**

| Strategy | Description |
|----------|-------------|
| `DB_UNIQUE_CONSTRAINT` | Insert with unique key; catch duplicate key error and return success. |
| `DB_UPSERT` | `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`. |
| `IDEMPOTENCY_TABLE` | Dedicated table storing processed event IDs with TTL; check before processing. |
| `CONDITIONAL_UPDATE` | `UPDATE ... WHERE version = expected` — reject if version mismatch. |
| `PROVIDER_KEY` | Use provider-issued idempotency key (Stripe idempotency key, Svix message ID). |
| `HASH_FINGERPRINT` | Hash the request payload; check against a recent-processed log before executing. |

**Rule for webhook handlers:** Always check the provider event ID before processing. The event ID
is the idempotency key. Never process a webhook body without first verifying the event ID has not
been seen in this deployment.

---

## Step 3 — RETRY SURFACE DECLARATION

For each operation in the plan, declare whether it will be called in a retry-capable context:

| Operation | Retry Context | Max Retries | Backoff | Safe to Retry? |
|-----------|--------------|-------------|---------|---------------|
| `[operation]` | [webhook / queue / scheduled / manual] | [n or unbounded] | [linear / exponential / none] | YES / NO |

**If `Safe to Retry: NO`:** the operation must have a deduplication strategy from Step 2, or must
be wrapped in exactly-once delivery infrastructure. State which applies.

**If retry context is `unbounded`** (e.g., a queue with no max-retry cap): treat the operation as
`NON_IDEMPOTENT` regardless of its class. Unbounded retries assume the operation will eventually
be called more than once.

---

## Idempotency Contract Output

When Steps 1–3 complete, add an IDEMPOTENCY CONTRACT section to the plan:

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

This section must appear in the plan alongside or within the OPERATIONAL section.

---

## Hard Rules

1. Never classify a webhook handler as `NATURAL`. Webhooks are always `KEY_GATED` at minimum.
2. Never write a payment or subscription state transition without a deduplication strategy.
   Double charges are not recoverable.
3. An operation that calls an external API (email, SMS, charge) is `NON_IDEMPOTENT` unless the API
   provides an idempotency key mechanism and the plan uses it.
4. DB upserts are `NATURAL` only if the upsert key matches the logical identity of the record.
   An upsert on a surrogate key is not `NATURAL` — it may create a new record instead of updating
   the intended one.
5. If exactly-once delivery is required but the infrastructure does not provide it, the constraint
   must appear in RISKS with explicit acknowledgment. Do not assume at-most-once delivery in an
   at-least-once system.
