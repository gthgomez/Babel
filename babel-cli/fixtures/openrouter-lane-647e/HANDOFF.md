# OpenRouter provider lane handoff (647e)

**Status:** `READY_FOR_INDEPENDENT_REVIEW` (provider lane: **no transport patch**; qualification evidence only)

## SHAs

| Ref | SHA |
|-----|-----|
| Base / candidate (`main` at qualification) | `1dc598e2a2f1de914591570349708a6f01d66479` |
| Open PR #501 (do not edit) | `c741ec62e806fa4232b2781d8002a24228770078` @ `fix/structured-task-decision-state` |

## Configuration (no secrets)

- `OPENROUTER_API_KEY`: present in host env (length 73); not printed.
- Default **live Chat** command shape: `babel run --mode chat-headless --json --yes --project-root <ws> --model deepseek-v4.1-flash-openrouter <prompt>`
- Resolved route: `openrouter` / `deepseek/deepseek-v4.1-flash-1017` via `OpenRouterApiRunner`
- Research v2 policy smoke (distinct route): `deepseek-v4-flash-openrouter` → `deepseek/deepseek-v4-flash-0731` (`npm run test:research-v2-openrouter-route-smoke`)

## Baseline reproduction (model-free)

```bash
cd babel-cli && npm ci && npm run build
npm run test:research-v2-openrouter-route-smoke
npx tsx --import ./src/testinfra/register-no-ambient-inference.mjs --test src/runners/openRouterApi.test.ts
npm run test:openrouter-lane-647e-preflight
```

## Live qualification (executed on candidate SHA)

Isolated disposable workspaces copied from `fixtures/coding-output-acceptance/workspaces/*`. Evidence: `fixtures/openrouter-lane-647e/evidence/*` (redacted; no tokens).

| Scenario | Provider errors | Outcome | Cost (reported) |
|----------|-----------------|---------|-----------------|
| Read-only explain | 0 | `NO_CHANGE_REQUIRED` | $0.0014713 |
| Vague repair `fix this` | 0 | `UNVERIFIED_PATCH` (tests pass after edit) | $0.004879626 |
| Vague feature `make export work` | 0 | `BLOCKED_POLICY` | $0.004459416 |
| Multi-turn `--resume-chat` follow-up | 0 (no dispatch) | `FAILED_RETRYABLE` | unknown |

**Aggregate known Chat spend (three dispatched cells):** ~$0.010810342. Streaming preflight add ~$0.000022.

**Provider verdict:** OpenRouter transport, streaming, metadata, and billing fields behaved correctly on all dispatched model calls. Terminal outcomes reflect runtime acceptance/policy (#501 area untouched), not provider failure.

**Cancellation:** AbortSignal exercise inconclusive (stream settled quickly); no provider error.

## Scope / excluded

- No edits to ChatEngine runtime, evaluators, CI, AGENTS.md, or #501.
- #499 / #500 contracts: exercised via honest outcomes; no reimplementation.

## Risks / next steps

1. Independent re-run live matrix with `scripts/run_openrouter_lane_qualification.mjs --live` (billable).
2. Core lane: `--resume-chat` `FAILED_RETRYABLE` on conversation follow-up.
3. Full `VERIFIED_COMPLETE` qualification still blocked on acceptance/evaluator dependencies and #501.

## CI

Draft PR CI not yet polled at handoff; local `openRouterApi.test.ts` 9/9 pass; route smoke pass.
