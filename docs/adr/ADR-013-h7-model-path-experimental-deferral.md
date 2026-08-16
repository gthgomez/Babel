<!--
status: ACTIVE
last_verified: 2026-08-06
architecture_version: harness-v1
-->

# ADR-013 — H7 Model-Path Factorial Measurement Scope

> **Date**: 2026-08-06  
> **Status**: Accepted (amended same day: model-path cells measured via OpenRouter)  
> **Related**: [HARNESS_HARDENING_ROADMAP_V1.md](../architecture/HARNESS_HARDENING_ROADMAP_V1.md) §H7, [ADR-012](./ADR-012-canonical-harness-architecture-v1.md)

---

## Current state (2026-08-15)

The same-day amendment resolved the title conflict: model-path measurement was initially
**deferred** (no first-party keys), and later **limited same-model measurements became
available** (OpenRouter).

- **IMPLEMENTED / MEASURED:** local evaluation substrate; offline harness-factor factorial;
  limited same-model LLM factorial (`runSameModelLlmFactorial`, fixed controls) where
  actually evidenced.
- **NOT PROVEN:** full multi-stage Deep pipeline factorial (the Deep cell uses ChatEngine
  `executionProfile=deep`, not the full pipeline); broad SWE reliability lift; competitor
  comparisons; generalized provider/model conclusions.

Present-tense claims in the original text saying the model-path factorial is "explicitly
deferred" refer to the *initial* state before the same-day amendment; the measured cells
exist as scoped above.

---

## Context

Harness Hardening Roadmap H7 requires:

1. A **local eval substrate** (fixed controls, metrics, paired deltas, failure ledger, promotion records).
2. **Measured same-model factorial comparisons** for minimal loop, Chat, Deep, and hardening variants under controlled model/sampling/revision/permissions/verifier/environment factors.

Initially, no first-party model API keys (DeepSeek / Anthropic / OpenAI / DeepInfra) were present. An offline harness-factor factorial and this ADR deferred model-path cells so H1–H6 were not held hostage.

Later in the same program, **OPENROUTER_API_KEY** became available. `runSameModelLlmFactorial` measures minimal_loop vs chat_harness vs deep_profile under fixed controls (`openrouter:openai/gpt-4o-mini@temp0`).

## Decision

1. **Retain** H7 local substrate and offline harness-factor factorial as **IMPLEMENTED**.
2. **Measure** same-model LLM factorial via OpenRouter when `OPENROUTER_API_KEY` (or equivalent) is present — `runSameModelLlmFactorial` with fixed `model_snapshot`, sampling, repository revision, permissions, verifier profile, resource profile, and environment digest.
3. **Scope disclosure** (honest limits of the measured cells):
   - Deep cell uses ChatEngine `executionProfile=deep`, not the full multi-stage Deep pipeline.
   - Task set is a small explain-intent fixed suite (not production SWE reliability).
   - Competitor model-path comparisons remain **out of scope** until separately measured.
4. Without any model gateway key, model-path cells report `experimental_evidence: false` and the program remains incomplete for H7 model-path gates.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Claim H7 complete from substrate only | Violates roadmap: experimental proof required for model-path gates |
| Block entire H1–H6 shipping until model keys appear | Unrelated waves are independently evidenced |
| Fabricate model factorial numbers | Forbidden by goal integrity rules |
| Require production Docker model runs now | Same external credential/time dependency |

## Consequences

### Positive

- Honest maturity: offline harness-factor measured; model-path factorial measured only within the scoped same-model cells above.
- H1–H6 program completion is not held hostage by missing API keys.
- Clear reactivation path for H7 model-path evidence.

### Negative / costs

- Cannot claim model-fixed Chat/Deep reliability lift until deferred gates re-run.
- Marketing or external reliability claims must not cite deferred H7 model-path measures.

## Compliance

- Roadmap H7 status must list deferred gates with this ADR id.
- `runLocalEvalSubstrateSmoke` remains `experimental_evidence: false`.
- `runOfflineHarnessFactorial` may set `experimental_evidence: true` only with notes disclosing harness-factor (non-LLM) scope.
- Architecture evaluation maturity remains **PARTIAL / UNPROVEN** for production model-path reliability claims.
