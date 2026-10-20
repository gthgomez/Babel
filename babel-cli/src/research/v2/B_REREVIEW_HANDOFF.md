# Agent A → Agent B reciprocal rereview handoff

**Supersedes for review:** `59cd561b2414fcc32253de568c70285517eae1cd` (BLOCKED)  
**Proposed revision (local only, not pushed):** `c98318f86bbcfb037589f1a5de8998548acf2c46`  
**Contract version:** `2026.10.20-checkpoint.2`  
**Baseline:** `d9e42b14b00b6dba25f0415ae16b084363386a01`

Remote publication and dependent coding remain **held** until B and independent exact-head rereview approve this patch.

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
git diff 59cd561b2414fcc32253de568c70285517eae1cd..c98318f86bbcfb037589f1a5de8998548acf2c46 -- babel-cli/src/research/v2
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
| Reviewed HEAD | _pending_ |
| Verdict | APPROVE / BLOCK |
| Notes | _pending_ |
