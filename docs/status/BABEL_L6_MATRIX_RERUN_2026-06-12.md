# Babel CLI Reliability Matrix Rerun — 2026-06-12

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
> **Note:** This doc recorded a 36/44 result from a different test suite (test:lite-gate, not the full live reliability matrix). The live reliability matrix baseline was 20/44. See [BABEL_CLI_LIVE_EVAL_2026-06-18.md](./BABEL_CLI_LIVE_EVAL_2026-06-18.md) for the latest live reliability results (36/44 as of 2026-06-18 after 14 architecture fixes).

**Date:** 2026-06-12 (updated 2026-06-13 post-prior PR merge + follow-ups; 2026-06-17 audit)  
**Trigger:** Slice 4 L6.1 Baseline Rerun; PR #[reference] (JIT/context/pipeline split + co-evo)  
**Baseline Status:** **36/44 PASS** (test:lite-gate; this is NOT the live reliability matrix)
**2026-06-17 Audit:** The 8 write-fix failures (cases 36, 38-44) are from a dynamically-generated relicRun lite-fix benchmark, not from the `liveCliReliabilityMatrix.ts` 44-case matrix. All 8 fail on the same `subtract 4 !== 5` verifier assertion — a mock-fixture data mismatch in the relicRun benchmark harness. The smallFix pipeline (39/39 unit tests green) and parity corpus (8/8 Babel cells passing) confirm the fix pipeline itself is healthy. The relicRun benchmark failures can be resolved by updating the mock fixture answers to produce correct verifier output. The parity corpus now supports `--provider live` for live measurements.

**2026-06-17 Resolution:** Root cause identified and fixed. Two fixtures shared the same task text (`"Fix the failing Node test..."`) and target file (`src/math.js`): `lite-trust-demo/scenario.json` (checked first by mock provider) and `parity-corpus/small_bug_fix.json`. Both were updated to export `add` AND `subtract` functions, and a guard was added in `smallFix.ts` (`extractExportedFunctionNames`) that prevents mock-fixture matches when the fixture's exports don't cover all functions in the on-disk broken file. Parity corpus tests pass 20/20, smallFix tests pass 19/19.

**Expected L6 impact:** All 8 relicRun:lite-fix write-fix cases should now pass. Target: 44/44 on next rerun.

**2026-06-17 Benchmark Re-run:** `test:live-lite-discovery` (mock provider) re-run after fixture fix. **11/11 pass, 0 fail, 0 skip** — all previous 8 `subtract 4 !== 5` failures resolved. The `fix_scoped` and `do_vague_fix` write-fix scenarios now return `FIX_COMPLETE` with correct verifier output. Evidence artifact at `runs/live-lite-discovery/20260617T173023/`. The L6 `liveCliReliabilityMatrix.ts` 44-case matrix uses different fixture preparation functions (`prepareMathRepairFixture`) and is not affected by the parity corpus fixture fix — its write-fix cases fail for unrelated reasons (different broken implementation shape not matching any mock fixture).

---

## Summary of Results

* **Total Cases:** 44
* **Passed:** 36
* **Failed:** 8
* **Incomplete / Timed out:** 0

### Passed Cases
* 35 read-only `lite-plan` cases (cases 01–35) passed successfully.
* 1 write-fix case passed: `relicRun:lite-fix:write-fix-verifier-fail` (case 37).

### Failed Cases
The following 8 write-fix cases failed with exit code 1 due to `test_run` failure in the `relicRun` target:
* `case-36 (relicRun:lite-fix:write-fix-happy)`
* `case-38 (relicRun:lite-fix:write-fix-recovery)`
* `case-39 (relicRun:lite-fix:write-fix-multiple)`
* `case-40 (relicRun:lite-fix:write-fix-scorecard)`
* `case-41 (relicRun:lite-fix:write-fix-parallel)`
* `case-42 (relicRun:lite-fix:write-fix-continue)`
* `case-43 (relicRun:lite-fix:write-fix-worker-loop)`
* `case-44 (relicRun:lite-fix:write-fix-checkpoint)`

---

## Failure Diagnosis

For all 8 failed cases, the final verifier step (`test_run`) failed on the `subtract` test inside `relicRun.test.ts` with:
```
✖ subtract (0.4287ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  4 !== 5
```
This indicates that under mock execution, the final file content generated did not resolve the assertion, leading to a verifier rejection.
