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
| Normal-session enablement | PARTIAL | Runtime factory and `diagnose bdns`/`inspect bdns` surfaces are available; process witness is wired into local async execution | Automatic construction/closure of a session-owned BDNS runtime for every ChatEngine path is not yet complete |

## Enablement decision

BDNS is **diagnostic opt-in at the persistence layer** for this boundary. The
bounded process witness and canonical observation plumbing are safe to leave
available, but a session must explicitly construct `BdnsRuntime` to persist a
complete diagnostic bundle. This avoids creating a second lifecycle owner in
the existing ChatEngine shutdown path before its async finalization contract
is changed and tested.

The next promotion gate is to attach one runtime to the canonical session
owner, close it after canonical event flush, and prove that normal CLI runs
produce a bounded bundle without delaying or changing execution outcomes.
