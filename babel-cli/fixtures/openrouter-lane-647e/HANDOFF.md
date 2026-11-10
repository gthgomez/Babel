# OpenRouter provider lane handoff (647e)

**Status:** `READY_FOR_INDEPENDENT_REVIEW` (evidence + honest live runner; **no provider transport patch**)

## Qualification phases

| Phase | Command | Billable |
|-------|---------|----------|
| **1. preflight** | `npm run test:research-v2-openrouter-route-smoke` | no |
| **2. fixture_checks** | `npm run test:openrouter-lane-647e-preflight` (default) | no |
| **3. paid_provider_execution** | `npm run test:openrouter-lane-647e-preflight -- --live` | **yes** |

`scripts/run_openrouter_lane_qualification.mjs` always runs phases 1–2. **`--live` dispatches the full Chat matrix** via `scripts/openrouterLaneLiveQualification.mjs` (fresh fixtures, host oracles, stop on provider HTTP errors). Session run trees stay **ephemeral** (gitignored); only redacted JSON is committed.

## SHAs

| Ref | SHA |
|-----|-----|
| Pre-501 live trial base | `1dc598e2a2f1de914591570349708a6f01d66479` |
| #501 merged on `main` | `ed0c44451a493b70a3a4361cc3236ebb07b453e4` |
| Post-501 qualification merge head | `5b16e7e1ff165e6b032c6485c44125e713743fc7` (branch merges `main` + lane artifacts) |

## Evidence layout (do not conflate)

| Path | Label |
|------|-------|
| `evidence/pre-501-trial/chat-scenarios-redacted.json` | **Frozen** pre-#501 live receipts |
| `evidence/pre-501-trial/preflight-transport-redacted.json` | Pre-#501 streaming ping |
| `evidence/post-501-trial/chat-scenarios-post-501.json` | Post-#501 live trial (redacted) |

## Route / adapter

- Chat live route key: `deepseek-v4.1-flash-openrouter`
- Provider model: `deepseek/deepseek-v4.1-flash-1017`
- Adapter: `OpenRouterApiRunner`
- CLI shape: `babel run --mode chat-headless --json --yes --project-root <ws> --model deepseek-v4.1-flash-openrouter <prompt>`

## Post-501 live trial (paid cells)

Dispatched via `npm run test:openrouter-lane-647e-preflight -- --live` @ `5b16e7e1`. Receipt: `evidence/post-501-trial/chat-scenarios-post-501.json`.

| Cell | Provider errors | Terminal | Host check |
|------|-----------------|----------|------------|
| readonly_explain | 0 | `NO_CHANGE_REQUIRED` | tests still fail (unchanged) |
| vague_repair | 0 | `BLOCKED_POLICY` | oracle pass after edit |
| vague_feature_export | 0 | `UNVERIFIED_PATCH` | npm test pass |
| multiturn_resume | 0 (no dispatch) | `EXECUTOR_HALTED` | oracle still pass |
| cancellation_stream_abort | 0 | stream completed | n/a |

**Aggregate known cost:** ~$0.01212. Provider errors: **0**.

## Runtime handoff (not provider lane)

- `multiturn_resume`: `EXECUTOR_HALTED` on `--resume-chat` (no provider dispatch)
- `vague_feature_export`: `AGENT_FAILURE` / `BLOCKED` after successful OpenRouter turns
- Acceptance / `VERIFIED_COMPLETE`: core + evaluator lanes (#499–#501 on `main`)

## Scans

- Host: **no `pwsh`** → local `check-public-content-policy` / strict Gitleaks / supplemental **not run** here.
- PR #505: use **hosted** `public-content-policy` + `security` as public evidence only; maintainer private scan still required before merge.

## Reproduce

```bash
cd babel-cli && npm ci && npm run build
npm run test:openrouter-lane-647e-preflight              # offline
npm run test:openrouter-lane-647e-preflight -- --live    # billable matrix
```
