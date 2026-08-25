<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-25
-->

# BDNS Seeded Fault Matrix

This is the B7 acceptance matrix for the runtime contracts currently landed.
The entries distinguish directly recorded facts from diagnostic hypotheses.

| Fault | Detected | Facts | Diagnosis / confidence | Limitation |
| --- | --- | --- | --- | --- |
| Throwing subscriber | VERIFIED | Subscriber A failed; healthy subscriber continued; bus health is `observer_failed` | Observer degradation / high | The failing subscriber's own downstream state is unavailable |
| Queue overflow/coalescing | VERIFIED | Queue is finite; dropped/coalesced counters increase | Evidence partial / high | High-frequency records may be absent |
| BigInt/Buffer/Error/circular payload | VERIFIED | Stable serializer emits safe representations | Evidence safe / high | Redaction patterns remain policy-controlled |
| Process fails before start | VERIFIED by witness API test | Requested fact and failed-to-start fact are retained | Start failure / high | The bridge only covers explicitly instrumented Babel boundaries |
| Process exits non-zero after canonical success | VERIFIED | Canonical success and process exit 1 are separate facts | `PROCESS_OUTCOME_MISMATCH` / high | A process result without a correlation id remains uncorrelated |
| Process cancellation or timeout | PARTIAL | Explicit bridge emits cancel/timeout/killed facts | Outcome requires reconciliation / medium | Background kill paths need a future caller-owned correlation bridge |
| Declared write changes target | VERIFIED | Targeted before/after metadata and hash differ | Corroborated mutation / high | Hash is bounded for large files |
| Undeclared targeted mutation | VERIFIED | Changed path is absent from declared intent | `UNDECLARED_WORKSPACE_MUTATION` / high | Only paths supplied to the bounded witness are evaluated |
| Watcher unavailable or silent | VERIFIED | Reconciliation marks watcher source unavailable; hash evidence remains independent | Unknown from watcher alone | No watcher event never proves no mutation |
| Diagnostic writer unavailable | VERIFIED | Store records `persistence_degraded`; caller continues | Persistence degraded / high | Pending records at process crash can still be lost |
| OTel disabled | VERIFIED by architecture and existing OTel tests | Local correlation model has no OTel dependency | Local diagnostics remain valid | External trace enrichment is absent |
| Insufficient evidence | VERIFIED | Unknown canonical outcome and no process exit create no incident | Root cause unknown / honest | More evidence must be collected by an operator or later run |

## Differential value

Canonical Babel events can identify an explicit non-zero tool result. BDNS adds
value when an independently witnessed process outcome disagrees, when bounded
workspace metadata proves an undeclared change, or when it records that its own
evidence was lost. In cases where the canonical record already explains the
failure, BDNS should corroborate rather than emit duplicate incidents.

