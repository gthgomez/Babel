# Shared campaign preflight (Agent B → Agent A coordination)

Agent B added portable campaign preflight wiring that both G-L2/G-L3 missions and live operators should share:

- `babel-cli/scripts/research-v2-campaign-preflight-run.mjs` — sets `BABEL_RESEARCH_V2_CAMPAIGN` without POSIX-only `VAR=val` in `package.json`.
- `babel-cli/src/research/v2/campaign/researchV2CampaignPreflight.ts` — readiness checks (search provider, mission `model_route` vs effective OpenRouter route, OpenRouter credential **presence only**).
- `babel-cli/scripts/research-v2-campaign-preflight.mjs` — emits JSON + exits non-zero when `readiness.ready` is false (no `ok` line on failure).

If Agent A extends mission `model_route` resolution or multi-source discover, keep mission/effective route parity and preflight schema in sync here rather than duplicating checks in a second controller.
