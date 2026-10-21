# Engine (M1.3+)

`ResearchEngineSession` coordinates an admitted single-owner durable store and control admission helpers.

- `FixtureResearchModelBridge` — contract/tests only (not live research).
- `ProviderResearchModelBridge` — real {@link ResearchModelPort} over injected `LlmRunner` / `ProviderEngine` (live gated by `BABEL_RESEARCH_V2_ALLOW_LIVE_API`).
- `runAdmittedPlanningIteration` — admitted planning on an existing mission (bootstrap shell → model → persisted plan + accounting).
- `FetchSourceAccessPort` — governed GET via `admittedHttpGet` (scheme, DNS/private-address, redirect re-check, streaming byte cap).

See `cancelResumeControl.test.ts` for cancel → inspect → stale recovery → resume (no live API).
