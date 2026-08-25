<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-25
-->

# Babel Debugging Nervous System — Architecture v1

## Status

This is the B0 contract and merge boundary for the Babel Debugging Nervous
System (BDNS). Runtime slices must remain subordinate to this document and to
the normative harness architecture in `HARNESS_ARCHITECTURE_V1.md`.

## Goals

- Make difficult Babel failures explainable from independent, bounded evidence.
- Preserve provenance for canonical events, process witnesses, workspace
  witnesses, terminal observation, and optional trace correlation.
- Make loss, truncation, delay, disagreement, and unavailable sources visible.
- Keep diagnostics useful to both operators and agents without leaking secrets.
- Fail soft: healthy canonical execution must continue when BDNS is degraded.

## Non-goals

- A second execution engine or semantic state machine.
- A replacement for SessionEventV1, EvidenceGraph, workspace transactions, or
  verifier authority.
- Global process monkey-patching or unrestricted filesystem surveillance.
- Whole-repository hashing on every event.
- Required OpenTelemetry export.
- Automatic repair of user code or any mutation authority over user files.
- Raw prompt, environment-secret, authorization-header, or arbitrary file
  content retention.

## Ownership and trust boundaries

Canonical execution owns intent, policy, tool outcomes, completion decisions,
and mutation transactions. BDNS owns observation envelopes, bounded queues,
independent witnesses, reconciliation, incident projections, and diagnostic
retention. Presentation surfaces only render those results.

```text
canonical execution ──> canonical events / receipts / semantic state
          │
          └── bounded enqueue ──> BDNS subscribers
                                  ├── process witness
                                  ├── workspace witness
                                  ├── correlation / incidents
                                  └── durable diagnostics / operator views
```

No canonical path may await a BDNS subscriber, persistence write, watcher
operation, Git scan, or incident construction.

## Evidence vocabulary

- **FACT** — a directly recorded value from a named source, such as a
  canonical event or process exit code.
- **INFERENCE** — a deterministic relationship derived from facts, such as
  "the process record correlates to this tool call".
- **HYPOTHESIS** — a possible explanation that is not established by the
  recorded evidence.
- **CORROBORATION** — independent facts agree within their trust boundaries.
- **CONTRADICTION** — independent facts disagree; neither is silently replaced.
- **UNKNOWN** — the available evidence cannot establish the proposition.
- **TRUNCATED EVIDENCE** — a bounded capture ended before complete content was
  retained; this is never presented as complete.

## Observation envelope

Each BDNS record is versioned and carries:

- `source` and `kind`;
- session, turn, tool-call, process, workspace-transaction, and optional trace
  correlation identifiers;
- wall-clock and monotonic timestamps when available;
- an observer sequence number;
- an explicit evidence state;
- a bounded, redacted payload.

Observer sequence means **BDNS ingestion order only**. It does not prove that
the operating system or independent sources observed events in causal order.
Process start/end facts, canonical event ids, monotonic timestamps, and
correlation ids are retained separately so a diagnostic can state what is
known without overclaiming causality.

## Subscriber and backpressure contract

The bus supports multiple independently owned subscribers. Every subscriber
has a finite queue and asynchronous drain. Publication performs only a bounded
queue operation and schedules work. High-frequency records may be coalesced or
dropped; lifecycle and degradation records are preserved when capacity allows.
Every drop/coalesce increments explicit counters and changes evidence health to
partial. Subscriber exceptions disable only that subscriber and create an
observer-degradation record. Unsubscribe and close are deterministic and do
not wait forever for a failed consumer.

## Process witness boundary

Process lifecycle is observed only through explicit bridges at known Babel
execution boundaries. The witness may record sanitized executable/argument
classification, cwd classification, pid, timestamps, exit code, signal,
cancel/timeout state, and bounded output counts/digests. It does not capture
raw environment values or secrets. The witness never changes canonical tool
outcomes. A process/canonical mismatch is an incident, not a semantic rewrite.

## Workspace witness boundary

The workspace witness combines declared mutation intent, transaction receipts,
watcher signals, bounded targeted metadata/hashes, and Git candidates when
available. Watcher output is a signal plane, not proof. Missing watcher output
is `UNKNOWN` unless another source confirms the mutation. BDNS storage is
excluded from its own watch set and has no authority to repair or modify user
files.

## Correlation and incidents

Existing ids are preferred: session, turn, tool call, canonical event,
workspace transaction, process execution, and optional OTel trace/span ids.
BDNS incident ids are local diagnostic ids and do not replace those ids.

Incidents are bounded, meaningful inconsistencies only. Initial categories are
`PROCESS_OUTCOME_MISMATCH`, `UNDECLARED_WORKSPACE_MUTATION`,
`MISSING_EXPECTED_MUTATION`, `OBSERVER_DATA_LOSS`, `EVENT_SEQUENCE_ANOMALY`,
`PERSISTENCE_DEGRADED`, `TOOL_LIFECYCLE_INCOMPLETE`, and
`TERMINAL_OUTPUT_ANOMALY`.

An incident carries facts, inferences, optional hypotheses, confidence, and
evidence health as separate fields. It never overwrites the source facts.
Insufficient evidence produces `UNKNOWN`, not a fabricated root cause.

## Persistence and retention

Diagnostic persistence is local, versioned, redacted, session-owned, size
bounded, and fail-soft. JSONL is acceptable for append-only records; atomic
replacement is used for indexes/pointers. Rotation and retention are explicit.
Queue overflow, output caps, writer failure, corruption, and crash loss are
represented in the health state. Crash flush is best-effort and bounded; Babel
does not hang shutdown for diagnostics.

BDNS may write only inside its configured diagnostic storage. It must not write
user-code files, change Git state, or use a watcher to trigger mutation.

## Privacy and performance

Default capture is metadata-first: allowlisted classifications, identifiers,
counts, hashes, bounded redacted previews, and approved paths. Secrets are
redacted using the existing redaction infrastructure. Raw prompt and raw
environment capture are out of scope. The hot path performs no synchronous
filesystem scan, Git inspection, disk flush, network export, expensive
serialization, or incident reconstruction.

## OTel relationship

OTel ids may enrich a record when the existing tracer provides them. BDNS is
correct with OTel disabled, unavailable, misconfigured, or not exported. Local
diagnostic storage never waits on an OTel exporter.

## Merge boundaries

The campaign is intentionally serialized:

1. B0 architecture and inventory (this boundary).
2. B1 bounded multi-subscriber plumbing.
3. B2 explicit process lifecycle witness.
4. B3 bounded workspace witness.
5. B4 correlation and incident model.
6. B5 durable diagnostic recording.
7. B6 operator and machine-readable surfaces.
8. B7 seeded fault diagnosis and reconciliation.
9. B8 hardening, soak, privacy, Windows verification, and enablement.

Each slice must pass focused tests and exact-head review before the next
slice's assumptions are treated as available. If a later slice would require
violating this contract, the campaign stops for architecture revision.

