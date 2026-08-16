<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel OTel Schema v1

The Babel OTel schema v1 defines additive OpenTelemetry tracing for the control plane.
Tracing is **optional and disabled by default**; it can be enabled with
`BABEL_OTEL_ENABLED=true`. When enabled, Babel emits safe lifecycle metadata only and
writes `07_trace_context.json` into the run bundle for correlation.

## Span Model

- Root span: `babel.run`
- Child span: `babel.orchestrator`
- Child span: `babel.compiler`
- Child span: `babel.qa`
- Child span: `babel.executor.activation`

## Safe Attributes

The schema prefers IDs, enums, booleans, counters, hashes, and normalized metadata. Representative attributes include orchestrator version, requested/effective pipeline mode, selected entry counts, hashed ordered entry IDs, token budget totals, QA verdict, Evidence Gate status, CI metadata, VCS metadata, and deploy metadata.

## Baggage

Baggage is intentionally small:

- `babel.lane.id`
- `babel.evidence_gate.status`
- `babel.policy.version` when available

## Privacy Constraints

Tracing must not record raw prompts, compiled prompt bodies, user task text, tool command strings, MCP query text, secrets, Chronicle values, or sensitive absolute paths. The trace context artifact stores only safe identifiers and correlation fields, not full span payload dumps.
