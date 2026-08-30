<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-29
-->
# Babel Current Runtime Invariants

This is the compact regression contract for provider execution, model
intelligence, evidence, and repository integration. A change that cannot
preserve these invariants must fail closed and carry an explicit migration.

## Provider boundary

- OpenRouter is an OpenAI-compatible gateway and uses the neutral transport.
  It must not inherit from `DeepInfraApiRunner`.
- OpenRouter-specific behavior must not read, default from, or inherit
  `BABEL_DEEPINFRA_*` settings. DeepInfra environment names and endpoint
  compatibility remain in the DeepInfra wrapper only.
- Shared request/response, retry, streaming, usage, and failure handling lives
  in the neutral OpenAI-compatible transport. Provider wrappers supply only
  endpoint, credential, provider identity, and provider-specific fields.

## Model intelligence

- Exact model IDs are authoritative; aliases are resolution inputs and drift is
  recorded, never silently substituted.
- The exact DeepSeek 0731 route must never resolve through a `~latest` route.
- Lab/provider identity is separate from model identity. A provider capability
  claim is not evidence of a successful provider invocation.
- Limits are scoped to the provider, model, key, cell, and campaign boundary
  that established them.
- “Supported” is not “observed,” and “observed” is not “qualified.”
- Conflicts are first-class evidence. The authoritative execution envelope
  wins over inferred defaults; serializers must not invent missing values.

## Reliability and accounting

- The effective generation limit is the value sent on the wire and is recorded
  with the requested limit, envelope hash, and wire-policy hash.
- A finish-length signal is not by itself a model failure; attribution must
  distinguish budget exhaustion, provider behavior, transport, and delivery.
- HTTP 402 is normalized as a provider/accountability failure with preserved
  status and redacted message; it is not relabeled as a model failure.
- Unknown cost is `null`/unknown, never zero. Provider usage is ingested before
  cost estimation and the pricing source/precision remain visible.
- A circuit breaker stops systemic failures before more paid cells are sent.

## Evidence and packaging

- Raw provider observations and authoritative lifecycle events are immutable
  once recorded; derived summaries cannot replace them.
- Missing observations remain `UNKNOWN`; prose is context, not evidence.
- Cells with contaminated, incomplete, or failed preconditions are excluded
  from causal claims rather than counted as negative model outcomes.
- Retention is an explicit allow-list of seven fields. Per-cell packages keep
  the full cell evidence, redactions, attribution, and exclusion reason.
- Secrets, authorization headers, account identifiers, and key material never
  enter logs, diffs, packages, or PRs.

## Git development boundary

- Integration starts from a fresh `origin/main` worktree. A dirty canonical
  checkout is never an integration base.
- PR base/head are exact commit references. GitHub mergeability alone is not a
  verification result; tests, review, content policy, and secret gates are
  required.
- Preservation evidence is captured before reset, clean, branch deletion,
  worktree deletion, merge, or history rewrite.

## Regression enforcement

`src/runners/providerRuntimeIsolation.test.ts` statically checks the most
important provider boundary: OpenRouter cannot reintroduce DeepInfra coupling,
while DeepInfra remains the only wrapper allowed to name its environment
prefix.
