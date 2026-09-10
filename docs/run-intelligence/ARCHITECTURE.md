# Babel Run Intelligence architecture

Babel Run Intelligence (BRI) is a local, derived evidence catalog. It is not a new execution telemetry system and is not an archive system.

## Boundaries

Current evidence writers remain canonical: evidence bundles, durable session events, terminal reports, checkpoints, cost ledgers, and tracing keep their existing ownership. BRI invokes read-only adapters against a selected non-link run root and rejects a catalog located in or containing that root. It writes only a new catalog outside evidence. It does not mutate run metadata, FTS databases, WAL files, checkpoint state, or source artifacts.

The local SQLite catalog is derived. `identity_registry`, `run_containers`, `sessions`, `trials`, `execution_segments`, `artifact_instances`, `model_routing_observations`, `verifier_observations`, `outcome_observations`, and `failure_occurrences` preserve source references and receipts. `content_blobs` identifies bytes; it never collapses separate artifact instances into one occurrence. New logical entity IDs are random UUIDs stored in the local identity registry; pre-v2 mappings remain readable for migration compatibility.

## Availability and outcomes

Each unavailable fact is represented as one of `PRESENT`, `ABSENT`, `UNSUPPORTED`, `REDACTED`, `TRUNCATED`, `UNAVAILABLE`, `NOT_APPLICABLE`, `INVALID`, or `UNKNOWN`. A parser error is a receipt warning, not a failed run. Current adapters deliberately leave outcome observations `UNKNOWN`: agent terminal text and an execution report alone do not meet the independent-outcome contract.

## Query and privacy model

The `babel runs query <saved-name>` surface maps only to a typed fixed registry; it accepts no SQL. Rate results carry numerator, eligible denominator, unknowns, exclusions, and coverage. When an independently observed outcome or comparison provenance is absent, the result is `NOT_ESTABLISHED`, never a synthetic zero.

Normal BRI output exposes random logical IDs and safe structured operational metadata, not raw source locators, prompts, source bodies, error previews, commands, or artifact contents. The catalog keeps hashed locator tokens solely for local deduplication; these are unkeyed hashes and are not claimed as confidentiality for low-entropy locators. No export command is introduced in this phase.

## Evaluation, lineage, recovery, archive

The schema has additive seams for immutable CaseVersion definitions, frozen DatasetVersion membership, Evaluation/Rubric identity, Experiment, Annotation, ExposureRecord, and typed lineage edges. These are intentionally unpopulated by historical adapters until reviewed source evidence supports them. Checkpoint artifacts are cataloged as occurrences, not proof of recoverability. Archive and hydration remain future adapter interfaces; no cloud archive, eviction, deduplication, encryption, or object-lock behavior is active.
