# Research V2 contract checkpoint

**Version:** `2026.10.20-checkpoint.2`  
**Baseline:** `gthgomez/Babel` `d9e42b14b00b6dba25f0415ae16b084363386a01`  
**Agent:** A (shared foundation)  
**Status:** Revised contract + fake ports (post–#405 review). **Engine, CLI, persistence implementation, and live OpenRouter remain paused** pending B review of acquisition/normalization seam and coordinator release.

## Repair summary (checkpoint.2)

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
