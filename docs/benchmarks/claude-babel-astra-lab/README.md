# Claude Code vs Babel Astra Lab

The lab is benchmark-only and sequential (`MAX_ACTIVE_WORKER_HARNESSES=1`).
It compares only Claude Code and Babel Live on OpenCode Go using the exact
models MiMo-V2.5, LongCat-2.0, and DeepSeek V4 Flash. GLM is excluded.

Use [the v2 comparison contract and readiness guide](COMPARISON_READINESS.md)
for future campaigns. Legacy packet shape validity is not experimental validity.

## Deterministic verification

From `babel-cli/`:

```text
npm run test:claude-babel-lab
npm run test:comparison
npm run typecheck
```

The certification command writes redacted, content-free records under
`benchmarks/claude-babel-astra-lab/direct-certification/`. It exits nonzero and
does not call the provider when the Go credential is absent.

## Lab API

- `src/claude-babel-astra-lab/openCodeGoApi.ts` — exact-model Go transport,
  session header, typed failures, and no provider fallback.
- `src/claude-babel-astra-lab/receipt.ts` — canonical neutral receipt hashing.
- `src/claude-babel-astra-lab/trajectory.ts` — raw-preserving normalized events.
- `src/claude-babel-astra-lab/campaign.ts` — 3-pair / 6-run pilot matrix and
  9-pair / 18-run certification matrix with sequential execution.
- `src/fixtures/claude-babel-astra-lab/fixtures.ts` — T1/T2/T4 disposable Git
  fixtures and an external hidden verifier.

ProviderEngine registration is included. Leases coordinate writers; they do not
require a separate permission ceremony for already-authorized experiment work.
The standalone OpenCode CLI is not required.

## Astra handoff

Use `runComparisonCampaign` for new comparisons. It preserves invalid and
inconclusive cells alongside valid ones, and reports their exact reasons.
Give Astra the generated packet directory plus this instruction:

> Act as the supervisor and differential analyst for the Claude Code versus
> Babel Live Astra lab. Read the generated comparison packets and their
> referenced raw/normalized trajectories. Hold provider, exact model, task,
> fixture SHA, verifier, permissions, timeout, machine, and supervisor
> constant. Identify observed harness divergences, separate evidence from
> hypotheses, propose one minimal Babel mechanism change at a time, and define
> a regression fixture and held-out KEEP/REVERT/INCONCLUSIVE test. Preserve
> controller-owned completion, revision-bound evidence, independent
> verification, policy enforcement, replayability, and explicit attribution.
> Do not ask the operator to reconstruct state from scattered logs.
