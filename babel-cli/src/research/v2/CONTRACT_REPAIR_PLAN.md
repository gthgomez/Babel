# Contract repair plan (local, pre-consolidated review)

**Status:** superseded by local implementation of `2026.10.20-checkpoint.2` (not pushed; await review).  
**Current frozen head:** `59cd561b2414fcc32253de568c70285517eae1cd`  
**Remote writes / revised checkpoint:** **held**

Failing reproduction: `src/research/v2/contracts/contract-regression.test.ts` (4 tests, expected fail until repair).

## 1. ResearchStore — mission fence and operation settlement

### Problems (reproduced)

- `ResearchStoreEventKind` includes `external_operation_intent` / `external_operation_completed` but **no append APIs**.
- Evidence writes (`appendSource`, `appendPassage`, `appendFinding`, `appendModelReceipt`) lack **`MissionWriteContext`** (`mission_id`, `plan_revision_id`, optional `owner_generation` / cancel fence).
- `InMemoryResearchStore` uses `source_id` / `passage_id` / `question_id` / `operation_id` as `missionId`, so `listEvents(realMissionId)` drops evidence and usage.

### Planned repair (single revised checkpoint)

- Introduce `MissionWriteContext` (strict, required on every append except first `appendMission`).
- Add:
  - `appendExternalOperationIntent(ctx, intent: ExternalOperationIntent)`
  - `appendExternalOperationCompleted(ctx, completion: ExternalOperationCompleted)` with `settlement: succeeded | failed | uncertain`.
- Thread `ctx.mission_id` into **every** event’s `missionId` field.
- Optional: `appendPassage` / `appendFinding` reject when `ctx` mission ≠ mission on linked records.
- Update `InMemoryResearchStore` and contract tests; add positive lifecycle test mirroring regressions.

## 2. SourceAccessPort — admitted bytes vs extracted passages

### Problems (reproduced)

- `read()` returns `SourceRevision` + **`PassageRecord[]`** — port performs extraction, leaving **no admitted raw-byte seam** for B-owned HTML/PDF parsers.

### Planned repair

- Split responsibilities:
  - **`fetchContent` / `readContent`** (name TBD with B): returns `AdmittedContent` — bounded `inline_bytes` (base64 or Uint8Array in TS) or `blob_ref`, plus `SourceRevision` metadata (`completeness`, `byte_length_received`, `truncation_reason`, `media_type`). **No passages.**
  - **`search`**: unchanged (discovery snippets only).
- **SourceAdapter.read** (new): calls admitted content, runs parser, returns `{ revision, passages }` for store append under mission context.
- Engine-owned technical readers may use the same adapter interface or a technical parser helper; still no ambient `fetch`.

## 3. SourceAdapter surface

- Add `read(request, access): Promise<SourceAdapterReadResult>` alongside `discover`.
- Registry remains A-owned; B implements web/document adapters against admitted content only.

## 4. Versioning and coordination

- Bump `RESEARCH_V2_CONTRACT_VERSION` once (not per partial edit).
- Migrate `fakePorts.ts`, `exampleMission.ts`, and regression tests to green in **one** commit after consolidated review.
- Agent B must sign off on: mission context shape, operation settlement enums, `AdmittedContent` bounds, and adapter `read` signature.

## 5. Explicit non-actions (held)

- No engine, CLI, or live OpenRouter work.
- No `git push` / PR updates until coordinator releases revised checkpoint publication.
