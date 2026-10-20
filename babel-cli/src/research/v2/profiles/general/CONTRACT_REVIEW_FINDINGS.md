# Agent B non-author contract review

**Target head:** `59cd561b2414fcc32253de568c70285517eae1cd`  
**Contract version:** `2026.10.20-checkpoint.1`  
**Review date:** 2026-10-20  
**Tests run (isolated worktree, no network):**  
`node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs --test src/research/v2/**/*.test.ts` → **8/8 pass**

**Superseded by:** `REVISED_CONTRACT_CHECKPOINT.md` and `contract-regression/aCheckpoint59cd561b.characterization.test.ts`.

## Verdict: FIX (checkpoint.2 required before M1)

Schemas and fake ports are largely aligned with the shared annex. Two port-surface gaps block B-owned document/web adapter implementation without A-owned engine edits.

---

## Blocking findings

### 1. `SourceAdapter` exposes discovery only (no read seam)

**Path:** `babel-cli/src/research/v2/ports/sourceAdapter.ts` **L19–L23**

Annex and Agent A `CHECKPOINT.md` ask B to implement adapters with **discover and read** through `SourceAccessPort`. The frozen interface defines only:

```ts
discover(request, access): Promise<SourceDiscoverResult>
```

There is no `read(...)` (or equivalent) on `SourceAdapter`, and `SourceAccessPort.read` returns passages without a hook for B-owned PDF/HTML extraction. Without a defined adapter read/parser seam, document PDF locators (T-L2) cannot live solely in B-owned code.

**Requested amendment (A-owned):** add `read` to `SourceAdapter` (or a sibling `SourceReader` registered alongside adapters) that accepts `SourceReadRequest` + `SourceAccessPort` and returns `SourceReadResult` / passages with B-owned `extraction_version`.

### 2. `ResearchStore` event kinds without append APIs

**Path:** `babel-cli/src/research/v2/ports/researchStore.ts` **L8–L18** vs **L36–L45**

Event kinds `external_operation_intent` and `external_operation_completed` are declared but no `appendExternalOperation*` methods exist. Durability/cancellation semantics in the annex require intent-before-dispatch persistence.

**Requested amendment:** add append methods (or a single typed external-operation event writer) before M1 engine work.

---

## Non-blocking notes (general profile)

| Topic | Assessment |
|-------|------------|
| `as_of` / `jurisdiction` / `time_range` | **OK** — `UnknownValueSchema` + optional jurisdiction (`contracts/common.ts` L9–L13, `mission.ts` L49–L51) |
| Decision / comparison criteria | **OK for M0** — `intended_decision` + `constraints[]`; structured comparison dimensions can live in general `ResearchProfileDefinition` data (B-owned) |
| Search metadata | **OK** — `SourceSearchHit.completeness` `metadata_only` \| `snippet` (`sourceAccessPort.ts` L27–L32) |
| Fetch truncation | **OK** — `SourceRevision.completeness`, `truncation_reason`; read `partial` + `failureCategory: 'truncated'` |
| Redirects / SSRF | **Partial** — `private_address_blocked` present; no explicit `redirect_limit` category (acceptable if documented as `policy_denied`) |
| PDF page locators | **OK** — `PassageLocatorSchema` `kind: 'page'` (`passages.ts` L4–L10) |
| Assertion kinds | **OK** — five kinds in `findings.ts` L4–L10; recommendations map to `proposal` |
| Report sections | **OK** — declarative `reportSections` on profile; terminal `ResearchReportV2` envelope (`plan.ts` L47–L63) |
| Retention | **OK** — `visibility_retention` on mission (`common.ts` L63–L68) |
| Cancellation | **Partial** — read returns `cancelled`; search abort throws in fake (`fakePorts.ts` L69 vs L86–L92); unify before lifecycle fixtures |
| Naming | **Note** — `FindingRecord.source_integrity` shares enum with semantic support (`findings.ts` L36–L37); consider renaming to `citation_integrity` in a minor revision to avoid confusion |

---

## Approved as-is (checkpoint scope)

- Contract Zod package version freeze (`version.ts`)
- Mission V2 shape including optional `pinned_target_repository` for technical only
- Fake port harness sufficient for dual-profile **unit** tests once adapter read seam exists
- Example mission fixture (technical) validates parsing path

## B action after coordinator agreement

- Import shared contracts from integrated head; do **not** fork types locally
- Add `exampleGeneralMissionFixture` under B-owned `profiles/general/` only
- Implement adapters against amended `SourceAdapter` read seam
