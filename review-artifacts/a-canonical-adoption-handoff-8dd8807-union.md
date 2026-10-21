# A canonical checkpoint `8dd8807d` + B `cce13455` union (B branch `f060092c`)

**A published:** `8dd8807d65caa9456dd4f7d22582c500a18ba271` @ `2026-10-21T14:10:32Z` (git) — per-pin `discover_query`, bootstrap plan shell before engine pass, cancellation finalize outcomes.

**B preserved on merge:** `cce13455` trim-validated `discover_query`, T-L1 tree-first campaign queries, HTML/`5628` slice.

## B-added union evidence (tests only + A dependency modules)

`earlyCancelBootstrapUnion.reciprocal.test.ts` (actual `runResearchV2MissionWithOwnerSession` + durable store):

1. **Prior-aborted signal** — bootstrap shell admitted; **0** model invokes; **1** cancelled terminal after inspect reopen; owner released (`sessionControl === null`).
2. **Runner admission→bootstrap barrier** — `testSeams.afterMissionAdmitted` blocks real runner between `appendMission` and `ensureAdmittedBootstrapPlanShell`; abort at barrier, release, cold reopen; **0** model invokes; **1** cancelled terminal @ `{planId}-bootstrap`; owner released.
3. **Helper only (separate suite)** — `finalizeCancelledOwnerRunAndClose` without bootstrap shell → `pre_bootstrap_no_active_plan`, **0** terminals (not labeled as runner barrier regression).

During-inference cancel remains covered by `ModelEntryLatch` tests elsewhere.

## Focused test receipt (24/24 v2, exit 0; prior 23/23 TAP preserved)

`review-artifacts/b-focused-extraction-query-union-test-run.json` (v1 TAP retained) + `b-focused-extraction-query-union-test-run-v2.tap.txt` + `b-early-cancel-bootstrap-union.reciprocal.tap.txt` bound to union test source.

Production `npm run typecheck` / `npm run build` @ `cce13455`: **not rerun** — `b-cce13455-production-typecheck-build-receipt.json`.

## Chronology

Estimated `14:20Z` / `14:25Z` receipt fields corrected additively — `b-receipt-chronology-correction.json`.
