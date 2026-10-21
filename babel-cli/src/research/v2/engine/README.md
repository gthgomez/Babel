# Engine (M1.3+)

`ResearchEngineSession` coordinates an admitted single-owner durable store and control admission helpers.

- `FixtureResearchModelBridge` — contract/tests only (not live research).
- `ProviderResearchModelBridge` — real {@link ResearchModelPort} over injected `LlmRunner` / `ProviderEngine` (live gated by `BABEL_RESEARCH_V2_ALLOW_LIVE_API`).
- `runAdmittedPlanningIteration` — one store-backed planning step (tests first).
- `FetchSourceAccessPort` — admitted GET fetch; search stays on profile adapters + registry.

See `cancelResumeControl.test.ts` for cancel → inspect → stale recovery → resume (no live API).
