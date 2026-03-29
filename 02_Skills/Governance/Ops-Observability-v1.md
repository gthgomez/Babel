<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Ops Observability Protocol (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_devops`, `domain_compliance_gpc`
**Activation:** Load this skill for any task that writes, modifies, or replaces code with side effects — mutations, external calls, queues, scheduled jobs, or any operation that can fail silently.

---

## Purpose

`[SFDIPOT-O]` is the second most common QA rejection tag after `[EVIDENCE-GATE]`. It fires when a
plan has no declared failure modes, no logging strategy, and no recovery path.

Writing code that works in the happy path is not enough. Every operation that can fail will
eventually fail — in production, under load, with bad input, or during a deployment. This skill
converts the SFDIPOT-O check from a reactive rejection into a proactive pre-plan requirement.

A plan with no OPERATIONAL section is a plan that will fail silently in production. Silent failures
are worse than loud ones.

---

## Activation Condition

Load this skill for any task that includes at least one of:
- A mutation (write, update, delete, insert to a database or external API)
- An external call (HTTP, webhook, queue, third-party SDK)
- A scheduled job, cron, or background worker
- A state transition (auth, payment, subscription, session)
- An operation that could fail silently (no response, partial success, missing record)

Do NOT load this skill for read-only evidence tasks or static analysis tasks.

---

## Step 1 — OPERATION SURFACE

For every operation in the plan's MINIMAL ACTION SET, declare:

| Operation | Type | Can Fail? | Failure Mode |
|-----------|------|-----------|-------------|
| `[operation name]` | [mutation / external_call / state_transition / scheduled] | YES / NO | [what happens when it fails] |

**Failure types to consider:**
- `SILENT` — operation fails with no error surfaced to caller
- `PARTIAL` — some but not all side effects were applied
- `TIMEOUT` — operation started but did not complete
- `IDEMPOTENT_VIOLATION` — retry causes a duplicate side effect
- `EXTERNAL_DEPENDENCY` — third-party service unavailable

If any operation has failure mode `SILENT` or `PARTIAL`, that operation requires a recovery path
in Step 3.

---

## Step 2 — LOGGING STRATEGY

For each operation classified in Step 1, declare what is logged and at what level.

| Event | Level | Fields |
|-------|-------|--------|
| Operation start | `info` | [request_id, user_id, operation_name, timestamp] |
| Operation success | `info` | [request_id, duration_ms, result_summary] |
| Recoverable error | `warn` | [request_id, error_code, retry_count, context] |
| Unrecoverable error | `error` | [request_id, error_code, stack_trace, context] |
| Silent failure detected | `error` | [request_id, expected_state, observed_state] |

**Minimum logging contract:**
- Every external call must log at start and completion (success or failure).
- Every state transition must log before and after state with a correlation ID.
- Every unrecoverable error must log enough context to reproduce the failure without guessing.

If the task cannot guarantee structured logging, declare it explicitly:

```
LOGGING: Unstructured — error propagation is caller-dependent. No centralized log surface.
```

---

## Step 3 — RECOVERY PATHS

For each operation with a non-trivial failure mode, declare the recovery path:

| Operation | Failure Mode | Recovery Strategy | Retry? | Fallback? |
|-----------|-------------|-------------------|--------|-----------|
| `[operation]` | `[mode]` | [description] | YES (n times, backoff) / NO | YES / NO |

**Recovery strategy options:**

| Strategy | Description |
|----------|-------------|
| `RETRY_WITH_BACKOFF` | Retries up to N times with exponential backoff. |
| `CIRCUIT_BREAKER` | Fails fast after N consecutive failures; recovers after timeout. |
| `IDEMPOTENT_REPLAY` | Safe to replay because operation is idempotent. Requires justification. |
| `COMPENSATING_TRANSACTION` | Undo prior steps if a subsequent step fails. |
| `DEAD_LETTER` | Route failed items to DLQ for manual recovery. |
| `FAIL_CLOSED` | Reject new operations until failure is resolved. Use for safety-critical paths. |
| `FAIL_OPEN` | Allow operations to continue despite failure. Use only for low-safety paths. |

**Rule:** `FAIL_OPEN` on a safety-critical path (auth, payment, permissions check) requires explicit
justification in KNOWN FACTS. The default for safety-critical paths is `FAIL_CLOSED`.

**When `skill_idempotency` is also loaded:** Do not justify `IDEMPOTENT_REPLAY` inline here.
Reference the IDEMPOTENCY CONTRACT section produced by `skill_idempotency` instead — it already
classifies the operation and provides the deduplication proof. Write:
`IDEMPOTENT_REPLAY — see IDEMPOTENCY CONTRACT` in the recovery table and leave the full
justification to that section.

---

## Operational Section Output

When Steps 1–3 complete, add an OPERATIONAL section to the plan using this structure:

```
OPERATIONAL
───────────
Operation Surface:
  [table from Step 1 — operation, type, failure mode per row]

Logging:
  [key events and log levels — include correlation ID scheme]

Recovery:
  [operation → strategy pairs]

Failure Modes Unmitigated:
  [any operation with no recovery path — state why it is acceptable]
```

This section must appear in the plan before VERIFICATION METHOD.

---

## Hard Rules

1. Never mark an operation `Can Fail: NO` if it involves an external call or a DB write. All
   external calls and DB writes can fail.
2. Never declare `FAIL_OPEN` on auth, payment, or permissions operations without explicit
   justification in KNOWN FACTS.
3. A comment in code (`// log this`) is not a logging strategy. The logging strategy must name
   the fields, the level, and the correlation ID scheme.
4. A plan with PARTIAL failure modes and no compensating transaction or idempotency guarantee
   is not safe to execute.
5. If the task modifies an existing operation that already has a logging or recovery strategy,
   the plan must explicitly preserve or supersede that strategy — not silently replace it.
