# Research V2 contract checkpoint

**Version:** `2026.10.20-checkpoint.1`  
**Baseline:** `gthgomez/Babel` `d9e42b14b00b6dba25f0415ae16b084363386a01`  
**Agent:** A (shared foundation)  
**Status:** Contract + fake ports only — engine, persistence, CLI registration, and live OpenRouter runs are **paused** pending Agent B review and coordinator relay.

## What is frozen

- Zod schemas under `contracts/` for mission, sources, passages, findings, questions, plan revisions, and terminal report envelope.
- Port TypeScript interfaces under `ports/` for model access, admitted source access, adapters, durable store, and declarative profiles.
- Deterministic fake implementations under `fixtures/fakePorts.ts` for boundary tests without network or provider credentials.
- Example end-to-end **fixture** mission in `fixtures/exampleMission.ts` (data only, not a running engine).

## What is explicitly not included yet

- Shared engine loop, `ResearchStore` production implementation, ProviderEngine wiring.
- Technical/general profile runtime, adapter registry, CLI `research run|resume|cancel`.
- Live OpenRouter or web retrieval (await integration gates and canonical six scenarios).

## Review asks for Agent B

1. Confirm general-profile fields (`as_of`, jurisdiction, decision criteria) are sufficient without mandatory technical extensions.
2. Confirm `SourceAccessPort` result categories cover web/document truncation, redirects, and metadata-only discovery.
3. Confirm `PassageRecord` locators support PDF page references B will emit from document adapters.
4. Flag any need for additional assertion kinds or report sections before M1 implementation.

## Verification commands (deterministic)

```bash
cd babel-cli
npm run typecheck
node --import tsx --no-warnings=ExperimentalWarning --import ./src/testinfra/register-no-ambient-inference.mjs --test src/research/v2/**/*.test.ts
```

V1 research tests must remain unchanged by this checkpoint (no edits under `research/` outside `v2/`).
