# Research v2 persistence (M1+)

M1.1 introduces `DurableResearchStore`: a directory-backed `ResearchStore` that flushes an
`InMemoryResearchStore` JSON snapshot after each mutation. This is a conformance/runtime slice,
not event-log replay; writer fences and operation idempotency state travel with the snapshot.

Engine and live provider integration remain out of scope until canonical tests cover them.

## Concurrency and failure bounds (post–d9 review FIX)

- **Exclusive opener:** `.research-store.exclusive.lock` (`wx`) — second `open()` on the same directory throws `DurableStoreBusyError`; call `close()` to release after pending mutations drain. This does **not** by itself cover multi-CLI cancel/inspect or stale-crash resume; integrate via an admitted control path or operation-scoped locking — not routine manual lock deletion.
- **Same-instance serialization:** one staged→persist→publish transaction at a time per open handle (`MutationQueue`).
- **Staged commit:** mutations apply to a staged snapshot, flush to disk, then replace memory; flush failure reloads from disk (no ghost missions).
- **Restore:** `assertSnapshotIntegrity` cross-checks event log vs fence maps and **bidirectional** operation tracking vs intent/completion/reconciliation events (fail closed).
