# Pre-fix characterization evidence (Agent A checkpoint.1)

**Not acceptance.** These observations characterize defects in A head `59cd561b2414fcc32253de568c70285517eae1cd` / contract `2026.10.20-checkpoint.1`. They are **not** a second schema and **not** B-owned contract definitions.

Captured **2026-10-20** with:

```bash
export RESEARCH_V2_A_ROOT=/tmp/review-a-contract/babel-cli/src/research/v2
export RESEARCH_V2_CHARACTERIZE_PRE_FIX=1
cd /tmp/review-a-contract/babel-cli && npm ci
node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs \
  --test /workspace/babel-cli/src/research/v2/profiles/general/contract-regression/aCheckpoint59cd561b.characterization.nonacceptance.probe.ts
```

**Result:** 8 subtests failed, 1 passed (G-DEV brief correctly rejected by `ResearchMissionV2Schema` without normalization).

| # | Subtest | Failure summary |
|---|---------|-----------------|
| 1 | Store mission scoping | `source_recorded` not listed under real `mission_id` |
| 2 | External operation APIs | No `appendExternalOperation*` on `ResearchStore` |
| 3 | Adapter read + port bytes | No `SourceAdapter.read`; port lacks admitted acquisition seam |
| 4 | Passage/locator validation | Invalid inline/page shapes parse successfully |
| 5 | Model output validation | Fake accepts malformed scripted output |
| 6 | Revision/locator identity | Same `revision_id` after content change; degenerate line locators |
| 7 | Cost provenance | `unknown` usage may include `total_cost_usd` |
| 8 | Integrity vs semantic | Conflated enums on `FindingRecord` |
| 9 | Brief normalization | Brief invalid (expected); needs explicit B normalization layer |

After A publishes a coordinator-agreed checkpoint, behavioral acceptance remains **unimplemented** in B inventory; optional `acceptance.checkpoint.readiness.nonacceptance.probe.ts` documents readiness only (nonacceptance). Do not ship intentionally failing characterization probes in the default test path.
