<!--
status: ACTIVE
last_verified: 2026-09-14
-->

# Astra Chat Pretest Audit — Provenance

Date of decision: 2026-09-14. Decision: **RUN AFTER SPECIFIC FIXES**.

## Scope

This note records the provenance of the Astra chat pre-test audit packet. The
audit reviewed Babel public `main` at revision
`18fd3f50b33525f41bba5e5ce0d233097b5b7413`, then re-checked the live branch at
`017ec8cc28dbfbabf8138794096b1af00212b474`. That comparison added one document
(`ASTRA_PRETEST_READINESS_FINAL.md`, PR #180) and no runtime-code changes.

## Where the findings live

The audit ran in an external ChatGPT session. The substantive findings and the
proposed smallest repairs are captured in [README.md](./README.md). The raw
ChatGPT session export is not published: it contains a private conversation
permalink, second-precision activity timestamps, and exporter metadata. The
clone log is not published either, because it records an absolute path on the
operator's local machine. Both raw artifacts are withheld from this
publication.

## Method limits

The audited environment could not clone the repository: DNS resolution for
github.com was unavailable, so no repository clone or end-to-end test occurred.
The probes in [extracted_logic_probes.mjs](./extracted_logic_probes.mjs) are
offline, reduced control-flow models and manually transcribed expressions. They
demonstrate local failure mechanisms and positive controls; they are not a
runtime certification and do not establish the behavior of the integrated
engine, transport, providers, or TUI.

## Reproducing the probes

Run the probes with Node.js from this directory:

```sh
node extracted_logic_probes.mjs
```

This prints the JSON report to stdout and writes no file. To rewrite the
evidence file:

```sh
node extracted_logic_probes.mjs --out probe_results.json
```

The evidence file [probe_results.json](./probe_results.json) records the host
Node.js version used for the recorded run.

## Publication boundary

This packet publishes the decision, the findings, the offline probes, and the
recorded probe output. It withholds the raw session export and the clone log;
future re-runs with session metadata or local machine paths follow the same rule.
