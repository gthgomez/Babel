# Engine (M1.3+)

`ResearchEngineSession` coordinates an admitted single-owner durable store, fixture model bridge, and control admission helpers. See `cancelResumeControl.test.ts` for the canonical cancel → inspect → stale recovery → resume journey (no live API).
