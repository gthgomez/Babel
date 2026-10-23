# Research v2 persistence (M1+)

M1.1 introduces `DurableResearchStore`: a directory-backed `ResearchStore` that flushes an
`InMemoryResearchStore` JSON snapshot after each mutation. This is a conformance/runtime slice,
not event-log replay; writer fences and operation idempotency state travel with the snapshot.

Engine and live provider integration remain out of scope until canonical tests cover them.

## Concurrency and failure bounds (post–d9 review FIX)

- **Exclusive opener:** `.research-store.exclusive.lock` (`wx`) carries JSON `{ schema_version, session_id, pid }`; second `open()` on the same directory throws `DurableStoreBusyError`; `close()` releases only when on-disk lock payload still matches the handle binding. Multi-CLI **inspect**, **external cancel-request**, and **stale-crash owner recovery** use `control/researchStoreAdmission.ts` + `control/storeCancelRequest.ts`. End-to-end acceptance still requires engine/CLI integration — not lock deletion as routine ops.
- **Same-instance serialization:** one staged→persist→publish transaction at a time per open handle (`MutationQueue`).
- **Staged commit:** mutations apply to a staged snapshot, flush to disk, then replace memory; flush failure reloads from disk (no ghost missions).
- **Restore:** `assertSnapshotIntegrity` cross-checks event log vs fence maps and **bidirectional** operation tracking vs intent/completion/reconciliation events (fail closed).
