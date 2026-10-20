# Research V2 contract checkpoint

**Version:** `2026.10.20-checkpoint.3.1` (composition FIX atop frozen `d51418b3` export)  
**Baseline:** `gthgomez/Babel` `d9e42b14b00b6dba25f0415ae16b084363386a01`  
**Agent:** A (shared foundation)  
**Status:** Revised contract + fake ports (post–#405 review). **Engine, CLI, persistence implementation, and live OpenRouter remain paused** pending B review of acquisition/normalization seam and coordinator release.

## Repair summary (checkpoint.3.1 — composition FIX, not acceptance)

- Plan transition: `appendPlanRevision` binds ctx to **active** plan while activating a **new** `plan_revision_id`; rejects stale concurrent plan ctx.
- Ownership acquire: **required** `expected_writer_generation`; competing resumes fail closed.
- Late billing: post-terminal `usage_reconciliation` without prior completion (intent-only) or after uncertain completion; accounting-only (no evidence resurrection).
- Attempt identity: per `mission::operation::attempt` tracking, explicit retry, `ResearchModelInvocationRequest.attemptId`, nested `usage_settlement.attempt_id` validation.
- Composed lifecycle + negative regressions in `store-lifecycle.test.ts` (50 v2 tests total).

## Repair summary (checkpoint.3 — FIX pass, not acceptance)

- Store fencing: plan revision binding, terminal evidence fence, post-terminal `usage_reconciliation` only; public writer ownership acquire/replace/release.
- Operation lifecycle: mission + attempt identity, intent-before-completion, idempotent completion, uncertain-only reconciliation.
- Source discover typed cancel/fail; admitted inline-bytes MVP; empty-body explicit failure; truncation metadata.
- General brief normalization: six **verbatim** B `mission.json` files on disk (`fixtures/general-dev-brief-corpus/`) with SHA256 manifest; `hard_requirements`, `notes`, optional `as_of` → `unknown` (G-DEV-02/06 regressions vs frozen `74ee4276`).
- Deterministic passage ids; excerpt locators bounded to admitted text.

## Prior repair summary (checkpoint.2)

- Mission-scoped `MissionWriteContext` on all store writes; external operation intent/completion/reconciliation APIs.
- `SourceAccessPort.fetchContent` returns bounded admitted bytes + provenance; adapters own extraction via `SourceAdapter.read`.
- Discriminated passage locators/text refs; integrity (`valid|invalid|not_checked`) separate from semantic support.
- Validated model outputs per operation kind; failure/cancel/uncertain carry `usage_settlement`.
- `normalizeGeneralMissionBrief` for B corpus JSON (no casts); fixture model routes flagged `fixture_route: true`.

## Verification

```bash
cd babel-cli
npm run typecheck
node --import tsx --no-warnings=ExperimentalWarning --import ./src/testinfra/register-no-ambient-inference.mjs --test src/research/v2/**/*.test.ts
```

## B review gate

Confirm `fetchContent` + `SourceAdapter.read` seam, `search_provider_unavailable`, and normalization output before dependent adapter implementation.

Peer reviewers must also complete `SHARED_REVIEW_CHECKLIST.md` (B fixture paths on disk, colocated tests, independent `#404` FIX — not waived).
