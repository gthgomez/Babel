# A canonical checkpoint `8dd8807d` + B `cce13455` union (B branch `f060092c`)

**A published:** `8dd8807d65caa9456dd4f7d22582c500a18ba271` @ `2026-10-21T14:10:32Z` (git) — per-pin `discover_query`, bootstrap plan shell before engine pass, cancellation finalize outcomes.

**B preserved on merge:** `cce13455` trim-validated `discover_query`, T-L1 tree-first campaign queries, HTML/`5628` slice.

## B-added union evidence (tests only + A dependency modules)

`earlyCancelBootstrapUnion.reciprocal.test.ts` (actual `runResearchV2MissionWithOwnerSession` + durable store):

1. **Prior-aborted signal** — bootstrap shell admitted; **0** model invokes; **1** cancelled terminal after inspect reopen; owner released (`sessionControl === null`).
2. **Admission before bootstrap init** — manual runner slice after `appendMission`, before `ensureAdmittedBootstrapPlanShell`; **0** model invokes; finalize `pre_bootstrap_no_active_plan` (**0** terminals — honest window); owner released on reopen.

During-inference cancel remains covered by `ModelEntryLatch` tests elsewhere.

## Focused test receipt (23/23, exit 0)

`review-artifacts/b-focused-extraction-query-union-test-run.json` + `.tap.txt`

Production `npm run typecheck` / `npm run build` @ `cce13455`: **not rerun** — `b-cce13455-production-typecheck-build-receipt.json`.

## Chronology

Estimated `14:20Z` / `14:25Z` receipt fields corrected additively — `b-receipt-chronology-correction.json`.
