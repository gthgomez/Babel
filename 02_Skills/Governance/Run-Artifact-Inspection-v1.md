<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Run Artifact Inspection (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the task is to inspect, review, summarize, or build tooling around existing Babel run artifacts, evidence bundles, manifest files, stack resolution output, routing telemetry, or operator-facing inspection commands.

---

## Purpose

Babel runs are evidence bundles, not chat transcripts. When a task asks what happened in a run,
what governed a run, or what artifacts back a run, the correct move is to inspect the existing
bundle directly and answer from what is actually present.

This skill prevents three common failure modes:

- inventing summaries that the run never wrote
- skipping the canonical artifact order and missing the real source of truth
- treating debug context snapshots as primary evidence instead of last-resort support material

Use this skill to keep inspection work read-only, artifact-first, and operator-honest.

---

## Step 1 — RESOLVE THE RUN TARGET

Before reading anything else, lock the run target:

- explicit run directory path if the user gave one
- project-scoped latest pointer if the user asked for "latest" on a project
- global latest pointer only if no scoped run target exists

If no run target resolves cleanly, stop and report that clearly.

Do not infer a run from vague surrounding context when a latest pointer or explicit path is absent.

---

## Step 2 — READ ARTIFACTS IN CANONICAL ORDER

Read artifacts in this order unless the task requires something narrower:

1. `01_manifest.json`
2. `06_runtime_telemetry.json`
3. `07_trace_context.json`
4. `08_routing_decision.json`
5. `05_waterfall_telemetry.json`
6. `02_swe_plan_v*.json`
7. `03_qa_verdict_v*.json`
8. `04_execution_report.json`
9. optional summary artifact if one actually exists
10. `00_ctx_*.md` only if the answer is still blocked after reading the primary JSON artifacts

Treat `01_manifest.json` as the governing source for:

- target project
- task summary
- prompt manifest
- typed instruction stack
- compiled artifacts

Treat `06_runtime_telemetry.json` as the primary source for:

- final outcome
- pipeline mode
- QA verdict
- routing confidence carry-through

Treat `00_ctx_*.md` as debug support only, never as the first answer source.

---

## Step 3 — MAP THE OPERATOR QUESTION TO THE RIGHT VIEW

Use this mapping:

### "What happened in this run?"

Answer from:

- run identity
- manifest task summary
- runtime final outcome
- stage artifacts present / absent
- waterfall and QA/executor artifacts when present

This is a run overview, not a raw artifact dump.

### "What is the concise human-readable account?"

Only use a summary artifact if one exists.

If no summary artifact exists, say so explicitly:

`No summary artifact is present for this run.`

Do not fabricate a retrospective summary from other files unless the task explicitly asks for a new derived summary.

### "What instruction stack governed this run?"

Answer from:

- `instruction_stack`
- `compiled_artifacts.selected_entry_ids`
- `compiled_artifacts.prompt_manifest`

Preserve resolved order. If names or types are not explicit, infer only from path family
(`Behavioral_OS`, `Domain_Architects`, `Skills`, `Model_Adapters`, overlays).

### "What evidence/artifacts back this run?"

Answer from the actual files in the run directory plus the known standard artifact set.

Mark artifacts as:

- present
- missing
- unavailable

Do not pretend a standard artifact was produced if the file is absent.

---

## Step 4 — RENDERING RULES

When inspection output is intended for the Babel CLI:

- use the shared UI layer, not ad hoc string formatting
- prefer `wrap` or `full` overflow modes for paths, ids, and artifact references
- keep sections calm and audit-friendly
- prefer concise metadata rows over prose when the question is inventory-oriented

Use truncation only for surfaces whose purpose is glanceability, not provenance.

For stack and manifest views, preserving long ids and paths matters more than compactness.

---

## Step 5 — HONESTY RULES

If an artifact is missing:

- say it is missing
- do not synthesize its contents
- do not silently substitute a neighboring artifact as if it were equivalent

If data is malformed:

- report that the artifact could not be parsed
- continue with other available artifacts if safe

If multiple artifacts disagree:

- prefer the canonical later-stage runtime artifact for outcome questions
- prefer the manifest for governing-stack questions
- call out the disagreement explicitly instead of averaging them into a smoother story

---

## Hard Rules

1. Inspection work is read-only. Never mutate a run bundle while answering inspection questions.
2. Never fabricate a summary artifact when the run did not produce one.
3. Never treat `00_ctx_*.md` debug snapshots as the primary evidence source if JSON artifacts exist.
4. Never reorder stack entries for readability; preserve resolved order.
5. Never hide missing artifacts just because the UI would look cleaner.
