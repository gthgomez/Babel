<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-25
-->

# BDNS B8 Hardening and Enablement Gates

This document records the hardening boundary for the first BDNS runtime
slices. It is intentionally evidence-based: a gate is marked verified only
when a local test or repository check exercises it.

| Gate | Result | Evidence | Remaining limitation |
| --- | --- | --- | --- |
| Bounded asynchronous publication | VERIFIED | `hardening.test.ts` publishes 2,000 canonical events to a queue of 8 and asserts bounded publication latency plus explicit loss counters | The latency threshold is a regression guard, not a production SLO |
| Slow-subscriber isolation | VERIFIED | Observation bus tests cover a slow subscriber and a throwing subscriber | A process crash can still lose queued observations |
| Redaction and unusual values | VERIFIED | Serialization tests cover BigInt, Buffer, Error, circular values, API-key-shaped fields, and authorization-shaped fields | Redaction remains dependent on the shared redaction policy |
| Bounded durable storage | VERIFIED | Store tests cover redaction, atomic summary replacement, writer failure, record caps, and total byte caps | Existing files are treated as a new run only when the run directory is new |
| Bounded diagnostic reads | VERIFIED | Reader caps summary/JSONL file size and JSONL record count | Corrupt or oversized artifacts are reported as unavailable/corrupt, not repaired |
| OTel independence | VERIFIED | Architecture contract and existing OTel tests preserve local operation without export | No external trace enrichment is available when OTel is disabled |
| Windows portability | PARTIAL | Typecheck and focused tests run on Windows; path classification is explicit and workspace-root jailed | Full CI-equivalent Windows/public-release gates remain required before merge |
| Normal-session enablement | VERIFIED | `sessionAttach.test.ts` constructs a session-owned runtime from `finalizeParityTurnSync` and writes a bounded bundle; process `toolCallId` is forwarded through `executeActionWithPolicy` → `shellExecAsync` | Persistence is flushed after canonical event flush and is not awaited on the hot path; ChatEngine still does not own an explicit dispose hook |

## Enablement decision

BDNS persistence is **session-owned and attached at the canonical flush choke
point**. `flushSessionEventsRequired` schedules a fail-soft `BdnsRuntime`
construct/flush after session-event durability. Canonical finalize does not
await BDNS. Process observations carry `sessionId` and `toolCallId` when the
policy executor has an idempotency key.

Do not expand BDNS into a telemetry platform, incident dashboard, or B9–B11
debugging campaign. Persistence and operator surfaces stay thin. The next
major campaign is Executable Acceptance V0, which may consume
`EvidenceCandidateV1` records without giving BDNS authority to define success.
