# Revised contract checkpoint — Agent B consolidated review (FIX)

**Reviewed head (read-only):** `59cd561b2414fcc32253de568c70285517eae1cd`  
**Supersedes:** informal BLOCK notes; targets **`2026.10.20-checkpoint.2`** (proposed, A-owned)  
**Agent B posture:** no edits to A-owned trees; no adapter/engine implementation until coordinator accepts revised seam.

## Verdict

**FIX required** on shared contract/ports/fakes (bounded repair, same architecture).  
**Hold:** product engine, CLI, live OpenRouter, remote pushes, dependent B adapters.

## Positives (unchanged)

- V2-only surface; V1 hunt/inspect and provider paths untouched in checkpoint.
- Declarative `ResearchProfileDefinition`; async ports with `AbortSignal`.
- No secret material in reviewed artifacts.

## Required repairs (A-owned; B regression tests encode expectations)

### 1. Store `missionId` scoping (`fakePorts.ts` L159–177)

**Defect:** `appendSource` / `appendSourceRevision` / `appendPassage` / `appendFinding` / `appendModelReceipt` call `push(source_id|question_id|operation_id, …)`, so `listEvents(realMissionId)` drops evidence events.

**Fix:** Every write carries **mission context** (parameter or scoped store handle).  
**Tests:** Two isolated missions each with source → revision → passage → finding → model receipt; `listEvents` per mission must be complete.

### 2. External operation lifecycle on `ResearchStore`

**Defect:** Event kinds `external_operation_intent` / `external_operation_completed` exist without typed append APIs; no duplicate-completion, stale-owner, cancel, or uncertain-dispatch contract.

**Fix:** Typed operation attempts, intent/completion/reconciliation, known vs uncertain settlement, owner + plan-revision preconditions (contract + fakes only in checkpoint.2).  
**Tests:** Fake store covers duplicate completion, stale owner, cancellation mid-flight, uncertain dispatch.

### 3. Acquisition seam (`SourceAdapter` + `SourceAccessPort`)

**Defect:** `SourceAdapter` discover-only; no admitted **bounded raw-byte/stream/reference** result with media type, final URL/redirect provenance, truncation. Search cannot express typed failure/cancel vs zero hits.

**Fix:** `read`/`extract` on adapter; port-level admitted acquisition result; network policy remains A.  
**B constraint:** document/PDF parsing consumes admitted bytes only — **no raw fetch bypass.**

### 4. `PassageRecord` / locator / text_ref validation

**Defect:** `PassageTextRef` allows inline without `text`, blob without `blob_ref`, or both; locators allow page `0`, inverted ranges, weak page strings.

**Fix:** Discriminated unions + negative fixtures + valid PDF page locator golden.  
**Note:** Hash-format tests ≠ issued-ID / citation-support validation (keep separate).

### 5. `ResearchModelPort` validation

**Defect:** Generic `T` without validator; fake casts arbitrary output; failures are generic `Error` without usage settlement.

**Fix:** Operation-discriminated outputs with schema/parser; result type for failure/cancel with known/uncertain usage settlement.  
**Tests:** Malformed structured output rejected.

### 6. Fake port identity & locators

**Defect:** Revision/passage IDs depend only on `source_id`; changed bytes reuse IDs; multiline bodies get `line_range` 1–1.

**Fix:** Revision-aware immutable IDs, bounded locators from actual content, injectable clock.  
**Tests:** Same-content reread vs explicit new revision on byte change.

### 7. Cost / usage provenance

**Defect:** Flat optional `total_cost_usd` with `cost_status` allows ambiguous shapes.

**Fix:** Discriminated `reported` (requires amount), `estimated` (method), `unknown` (no fake amount); preserve missing usage as unknown; attempt identity where available.

### 8. Source integrity vs semantic support

**Defect:** `SourceIntegrityResultSchema` reuses semantic states (`supported` / `contradicted` / …).

**Fix:** Integrity: `valid` | `invalid` | `not_checked`; semantic support keeps judgment enum separately.

### 9. General briefs ≠ `ResearchMissionV2`

**Defect:** G-DEV JSON briefs are not valid missions; must not `as ResearchMissionV2` cast.

**Fix:** Explicit **profile normalization** function (tested) from brief → mission; example OpenRouter slug remains fixture data, not live route selection.

## B acquisition / normalization review (pre-freeze)

Before contract freeze.2, B will review:

- Admitted byte acquisition → document adapter extract → `PassageRecord` with `page` locators (T-L2 path).
- Brief → mission normalization for general profile (item 9).

## Verification (author claims not sufficient)

**Pre-fix characterization (not acceptance):** opt-in only; evidence frozen in `contract-regression/CHARACTERIZATION_EVIDENCE_59cd561b.md`. Default repo tests **skip** intentional A checkpoint.1 failures.

**Post-repair acceptance:** after coordinator agrees checkpoint.2, set `RESEARCH_V2_RUN_ACCEPTANCE=1` and run `acceptance.checkpoint.test.ts` against repaired `RESEARCH_V2_A_ROOT`.

Prescribed push guards (no waiver assumed): `agent-preflight`, `check-public-content-policy`, `run-public-secret-scan -Strict -RequireExternalScanner`. Maintainer pre-merge additionally requires `validate-public-release.ps1 -Strict -RequireSupplementalPolicy` with real `BABEL_PRIVATE_SCRUB_POLICY_PATH` or approved `-SupplementalPolicyPath` (absence blocks maintainer pre-merge only, not ordinary push scrub).

## Publication

- Draft **#404** unchanged on remote until coordinator releases push after exact patch review.
- This document + regression tests are **B-owned**, local until relay.
