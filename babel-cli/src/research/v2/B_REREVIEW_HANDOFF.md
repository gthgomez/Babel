# Agent A → Agent B reciprocal rereview handoff

## Active coordination (2026-10-21)

| Track | Draft PR | Published head (exact GitHub) | Owner |
|-------|----------|-------------------------------|--------|
| Agent A integration | [#406](https://github.com/gthgomez/Babel/pull/406) | `40dadfa2` (`cursor/research-v2-post-review-settlement-fc31`) | Combined runtime, CLI/engine, registry wiring, **web discover** |
| Agent B extraction/tests | [#404](https://github.com/gthgomez/Babel/pull/404) | `c470f0cb` (tests-only on B80 catalog) | Read/HTML/PDF extraction, reciprocal integration tests |

**Discover contract on #406:** `GeneralWebAdapter.discover` delegates to `access.search` and maps hits to web candidates (`generalWebAdapter.test.ts`). **Do not** replace `generalWebAdapter.ts` with B80, whose discover returns `not_supported` without search. `GeneralDocumentAdapter.discover` remains honestly `not_supported` (mission-selected documents).

B `c470f0cb` reciprocal tests assume B80 discover for **both** catalog adapters; when B rebases tests onto #406, web discover expectations should follow A search-backed behavior while read/HTML/PDF/cancellation cases stay B-owned.

Review uses exact published heads; no manual patch-export gate. Credentials unchanged.

---

**Supersedes for review:** `59cd561b2414fcc32253de568c70285517eae1cd` (BLOCKED)  
**Published draft head (PR #405):** `17838c028c0a8a80f9745b01d1525983752e0eae` on branch `cursor/research-v2-contract-a-fc31` (tree `2ad1a8b0fbd448828327a261b78b87d97e28fdaf` at last publication)  
**Contract version:** `2026.10.20-checkpoint.3.1` (composition FIX + verbatim B corpus; base `d51418b3`)  
**Baseline:** `d9e42b14b00b6dba25f0415ae16b084363386a01`

Remote publication and dependent coding remain **held** until B and independent exact-head rereview approve this patch.

**Coordinator guards:** Missing supplemental scrub policy blocks **maintainer pre-merge** (`validate-public-release.ps1 -RequireSupplementalPolicy`), not local contract repair, tests, or export review. **No campaign waiver; no merge authority.** Remote writes stay held until release after exact-head review.

**Shared checklist:** `SHARED_REVIEW_CHECKLIST.md` — includes mandatory B fixture-path verification; Agent A’s first peer pass missed broken B paths; **`#404` FIX is controlling and not waived.**

## B BLOCK findings → repair mapping

| B finding (59cd561b) | Repair in checkpoint.2 |
|----------------------|-------------------------|
| `sourceAdapter.ts` discover-only | `SourceAdapter.read()` + `SourceAdapterReadResult` (`ports/sourceAdapter.ts`) |
| `researchStore.ts` operation event names without append APIs | `appendExternalOperationIntent/Completed/Reconciled` (`ports/researchStore.ts`, `fixtures/fakePorts.ts`) |
| `listEvents` loses evidence | `MissionWriteContext` on every write; mission id on all events |
| Typed search cancel vs zero hits | `SourceSearchResult` status `ok \| failed \| cancelled` (`ports/sourceAccessPort.ts`) |
| Integrity enum conflated with semantic | `SourceIntegrityStateSchema` vs `SemanticSupportStatusSchema` (`contracts/findings.ts`) |

## Nine-point independent review (authoritative scope)

All nine items are addressed in this single local revision; see `CHECKPOINT.md` and `contracts/contract-regression.test.ts`.

## Inspect patch (no shared filesystem)

```bash
git fetch origin cursor/research-v2-contract-a-fc31   # after coordinator publishes
git diff 59cd561b2414fcc32253de568c70285517eae1cd..HEAD -- babel-cli/src/research/v2
```

Or apply from coordinator-supplied bundle when released.

## B verification commands (isolated worktree)

```bash
cd babel-cli
npm ci
npm run typecheck
node --import tsx --no-warnings=ExperimentalWarning --import ./src/testinfra/register-no-ambient-inference.mjs --test src/research/v2/**/*.test.ts
```

**Expected:** 22/22 pass (8 prior contract tests expanded; includes store, fetchContent, normalization, negative locators).

## B consumption notes

- General profile fields (`as_of`, `jurisdiction`, `intended_decision`) unchanged in shape; use `normalizeGeneralMissionBrief()` for corpus JSON — **no casts**.
- Structured decision criteria remain profile-owned; normalization flattens object `constraints` to string[] for V2 host validation.
- Document/HTML parsing: `access.fetchContent()` then adapter `read()` — **no raw fetch**.

## Rereview outcome (B fills in)

| Field | Value |
|-------|--------|
| Reviewed HEAD | _pending_ (await B relay of A `d51418b3`) |
| Verdict | APPROVE / BLOCK |
| Notes | _pending_ |

## Agent A reciprocal review of B fixture repair (2026-10-20)

| Field | Value |
|-------|--------|
| B head reviewed | `b2572ca844c21f444e79f253fc60b9295a67cb05` (patch verified; read-only snapshot) |
| Verdict | **APPROVE manifest/fixture slice only** — **NOT** campaign acceptance |
| Evidence | `review-artifacts/B_RECIPROCAL_REVIEW_A.md` (complete); A `74ee4276` at `review-artifacts/agent-a-frozen-74ee4276/` |
| A hold | `d51418b3` verified, **not accepted** — composition defects to consolidated native report; **no piecemeal repair** until then |
