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
# Babel OTel Local Validation Guide

## Overview

Babel Phase 1.5 activates the OpenTelemetry tracing foundation introduced in Phase 1. Tracing is **disabled by default** and observational only — it never affects routing, QA gates, or Behavioral OS semantics.

When enabled, each `babel run` emits a `babel.run` root span (with child spans per pipeline stage) to an OTLP backend, and writes `07_trace_context.json` into the run bundle for offline correlation.

---

## Prerequisites

- Docker (for local Jaeger)
- Node.js ≥ 20 (already required by `babel-cli`)
- A working `babel-cli` setup (configuration file configured)

---

## Quick Start — Local Jaeger

### 1. Start Jaeger

```bash
cd babel-cli
docker compose -f docker-compose.jaeger.yml up -d
```

Jaeger UI is now available at **http://localhost:16686**.

### 2. Enable tracing in your config file

Add or uncomment these lines in your environment configuration:

```env
BABEL_OTEL_ENABLED=true
BABEL_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
BABEL_OTEL_SERVICE_NAME=babel-cli
```

If an enterprise policy file is loaded, tracing also requires an explicit policy opt-in:

```json
{
  "schema_version": 1,
  "telemetry": {
    "opt_in": true
  }
}
```

With a managed policy present, `BABEL_OTEL_ENABLED=true` is not enough by itself. If `telemetry.opt_in` is missing or `false`, Babel disables OTel export and still writes the local trace-context artifact as disabled.

### 3. Run a babel pipeline

```bash
cd babel-cli
npm run dev -- run "Your task here"
```

Or via the CLI binary if installed:

```bash
babel run "Your task here"
```

### 4. Inspect traces in Jaeger

1. Open **http://localhost:16686**
2. Select service **`babel-cli`** from the dropdown
3. Click **Find Traces**
4. Click a trace to see the full span waterfall: `babel.run → babel.orchestrator → babel.compiler → babel.qa → babel.executor.activation`

### 5. Correlate with the run bundle

Every run bundle under `runs/<timestamp>_<task-slug>/` includes:

- `07_trace_context.json` — OTel trace ID, root span ID, baggage (use to search Jaeger by trace ID)
- `06_runtime_telemetry.json` — Babel pipeline metadata (domain, skills, QA verdict)

To find a trace in Jaeger by ID, copy `trace_id` from `07_trace_context.json` and use Jaeger's **Search by Trace ID** feature.

---

## Stopping the collector

```bash
cd babel-cli
docker compose -f docker-compose.jaeger.yml down
```

---

## Safe-disable behavior

Set `BABEL_OTEL_ENABLED=false` (or leave it unset) to disable all trace export. When disabled:

- No OTLP connections are made
- `07_trace_context.json` is written with `"enabled": false` and no `trace_id` (run bundle is consistent regardless of telemetry state)
- No runtime behavior changes

Managed enterprise policy can also force this safe-disable behavior by setting `"telemetry": { "opt_in": false }`.

---

## What is and is not traced

**Traced (safe metadata only):**
- Orchestrator version, pipeline mode, domain ID, skill IDs (as hash)
- Token budget totals and warning severity
- QA verdict (`PASS` / `REJECT`) and Evidence Gate status
- CI/VCS metadata (repo, branch, SHA, PR number, deploy environment)
- Session ID (if using Local Mode)

**Never traced:**
- Raw prompt bodies or compiled prompt text
- User task text or any task content
- Shell command strings
- MCP query text
- Secrets or API keys
- Absolute file paths (stored as hashes only)

This matches the privacy constraints in `docs/architecture/BABEL_OTEL_SCHEMA-v1.md`.

---

## Alternative backends

Replace `BABEL_OTEL_EXPORTER_OTLP_ENDPOINT` with any OTLP HTTP endpoint:

| Backend | Endpoint | Notes |
|---------|----------|-------|
| Jaeger (local) | `http://localhost:4318/v1/traces` | Default local setup — see Quick Start above |
| Grafana Tempo | Per your Tempo instance | Standard OTLP HTTP — no extra config needed |
| OpenTelemetry Collector | Per your collector HTTP receiver config | Recommended for multi-backend fan-out |
| Honeycomb | — | **Not supported without code changes.** Honeycomb requires a `x-honeycomb-team` bearer header that the current `OTLPTraceExporter` setup does not inject. Route through a local OTel Collector instead, which can add headers via its `otlphttp` exporter config. |

---

## Running the regression test

The in-memory OTel regression test validates span structure and privacy constraints without a live backend:

```bash
cd babel-cli
npm run test:otel-tracing
```

Expected output: `otel tracing regression tests passed`

This test:
- Verifies 5 span types are emitted per run (`babel.run`, `babel.orchestrator`, `babel.compiler`, `babel.qa`, `babel.executor.activation`)
- Verifies `07_trace_context.json` is written with correct baggage
- Verifies no raw prompt text, task content, or file paths appear in span attributes

---

## Next step before Phase 2

Confirm traces appear correctly across several real runs in the local Jaeger backend before beginning Phase 2 (Production Lanes). Key things to verify:

1. All 5 span types appear in the waterfall for a verified-mode run
2. QA verdict baggage (`babel.evidence_gate.status`) updates correctly
3. Trace IDs in `07_trace_context.json` match what appears in Jaeger
4. No sensitive content visible in Jaeger span attributes
