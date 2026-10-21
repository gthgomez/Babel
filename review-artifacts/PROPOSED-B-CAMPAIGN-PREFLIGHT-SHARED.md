# Shared campaign preflight (Agent B → Agent A coordination)

Agent B added portable campaign preflight wiring that both G-L2/G-L3 missions and live operators should share:

- `babel-cli/scripts/research-v2-campaign-preflight-run.mjs` — sets `BABEL_RESEARCH_V2_CAMPAIGN` without POSIX-only `VAR=val` in `package.json`.
- `babel-cli/src/research/v2/campaign/researchV2CampaignPreflight.ts` — readiness checks (search provider, mission `model_route` vs effective OpenRouter route, OpenRouter credential **presence only**).
- `babel-cli/scripts/research-v2-campaign-preflight.mjs` — emits JSON + exits non-zero when `readiness.ready` is false (no `ok` line on failure).

If Agent A extends mission `model_route` resolution or multi-source discover, keep mission/effective route parity and preflight schema in sync here rather than duplicating checks in a second controller.

**Integrated with A `b0194564` (draft #406):** B branch carries A-owned `findingsFromModelOutput` + `modelOutputs` extract schema; B preflight (`researchV2CampaignPreflight.ts`, `research-v2-campaign-preflight-run.mjs`) unchanged in ownership.

**Integrated with A `c3c553a`:** semantic `question_coverage` + bound `question_text`; B reciprocal tests assert production behavior (historical gap doc only).

**Handoff paths missing at abd4 — B owns until A merges:**

- `babel-cli/src/research/v2/fixtures/campaign/G-L2-mission.json`
- `babel-cli/src/research/v2/fixtures/campaign/G-L2-expected-outcomes.json`
- `babel-cli/src/research/v2/fixtures/campaign/G-L3-mission.json`
- `babel-cli/src/research/v2/fixtures/campaign/G-L3-expected-outcomes.json`
- `babel-cli/src/research/v2/fixtures/campaign/G-L3-deterministic-insufficiency.fixture.json`
- `babel-cli/scripts/research-v2-campaign-preflight-run.mjs` + `researchV2CampaignPreflight.ts`

General multi-source loop remains A-owned — B actual-port tests extend at next checkpoint without a second controller.
