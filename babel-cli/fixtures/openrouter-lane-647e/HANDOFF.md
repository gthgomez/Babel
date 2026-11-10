# OpenRouter provider lane handoff (647e)

**Status:** `READY_FOR_INDEPENDENT_REVIEW` (qualification harness corrections; **no provider transport patch**)

## Qualification phases

| Phase | Command | Billable |
|-------|---------|----------|
| **1. preflight** | `npm run test:research-v2-openrouter-route-smoke` | no |
| **2. fixture_checks** | `npm run test:openrouter-lane-647e-preflight` | no |
| **3. paid_provider_execution** | `...preflight -- --live` or `--live --cancellation-only` | yes |

Build provenance: `ensureBabelCliDistReady` (`fail` before live, `ensure` inside matrix). Stale/missing `dist` **blocks** exact-head qualification.

## Evidence layout (frozen vs corrected)

| Path | Label |
|------|-------|
| `evidence/pre-501-trial/*` | Frozen **pre-#501** receipts (do not edit) |
| `evidence/post-501-trial/chat-scenarios-post-501.json` | Post-#501 full matrix (prior head) |
| `evidence/post-501-trial/invalid-trials/cancellation-invalid-signal-argument.json` | **INVALID_TEST** — wrong `executeWithToolsStream` arity; **not** product failure |
| `evidence/post-501-trial/cancellation-probe-corrected.json` | Corrected cancellation probe (`signal` 4th arg + `AbortController.abort()`) |
| `evidence/post-501-trial/redacted-run-records/<trial>.json` | Redacted CLI tails, terminal fields, workspace diffs **before** ephemeral run cleanup |

Ephemeral session trees under `runs/` remain gitignored and are deleted after redacted records are written.

## Cancellation probe conclusions (do not conflate)

1. **Invalid (preserved):** `{ signal }` passed as **3rd** argument → signal never forwarded → `unexpected_complete` is **INVALID_TEST** only.
2. **Corrected @ `9f7820b9+`:** `undefined, ac.signal` + `ac.abort()` at 120ms → `signal_forwarded: true`, observed `unexpected_complete`, 1 delta / 123ms, usage **unknown** (no runner metadata on abbreviated stream). This is **insufficient to certify cancellation**; it is **not** relabeled as pass.

## Export feature semantics (host-owned)

`vague_feature_export` is graded with `oracle/multi-file/score.mjs` (`invoke-greeting` + immutable-path hashes), not npm test alone. `export_semantic_pass` may be false while Babel terminal is `UNVERIFIED_PATCH`.

## Stop-on-provider-error

`detectBillableProviderStop` includes `[openrouter] Network error`, HTTP 402, 401/403/429/5xx, `stream closed before [DONE]`. `provider_errors_observed` counts exceptions **and** per-cell `provider_stop_matches`.

## Scans

Local `pwsh` / strict Gitleaks / supplemental policy: **not run** on this host. Hosted `public-content-policy` + `security` on #505 are public signal only.

## Commands

```bash
cd babel-cli && npm ci && npm run build
npm run test:openrouter-lane-647e-preflight
npm run test:openrouter-lane-647e-preflight -- --live --cancellation-only
```
