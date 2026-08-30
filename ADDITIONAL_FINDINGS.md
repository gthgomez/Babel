# Additional findings

## MI-012 — P1 — retrieval timestamps invalidated material profile hashes

- Root cause: profile hashing included `observedAt`/`retrievedAt` provenance fields.
- Impact: refreshing unchanged provider metadata could stale a qualification and
  change the execution-envelope identity without a capability change.
- Fix: profile hashes now exclude only retrieval timestamps while retaining all
  provenance in the stored profile and evidence artifacts.
- Verification: `src/intelligence/intelligence.test.ts` asserts timestamp-only
  refreshes preserve the profile hash and material limit changes alter it.
