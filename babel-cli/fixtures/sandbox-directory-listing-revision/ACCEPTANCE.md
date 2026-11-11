# Directory listing revision — acceptance contract

## Invariants

1. **Identity / anchors:** `validateDirectory`, `acquireEffectDirectoryAnchors`, and inode/dev checks at listing boundaries unchanged.
2. **Bound revision:** `Revision:` and continuation tokens use `combineDirectoryListingRevision(metadataRevision, entrySetDigest)` (`babel-directory-bound-v2` preimage → 64 hex). Metadata-only tuples do not alone authorize the next page.
3. **Full entry set (global):** Every dentry is hashed before pagination (`after` cursor). Per-entry leaf: `babel-directory-entry-v2` + name + displayed kind (`dir`/`file`). Set digest: `babel-directory-set-v2` + count + order-independent XOR-fold of leaf hashes (O(1) extra memory). Observed listing and a cancellation-aware independent `opendir` pass must agree (yields every 128 entries, `signal?.throwIfAborted()`).
4. **Not atomic:** Independent passes bound the listing window; not a kernel-level atomic snapshot or cryptographic attestation of the full filesystem.
5. **Drift detection:** In-enumeration add/delete/rename fails when listing digest ≠ validation digest, including when parent directory `mtimeNs`/`ctimeNs` stay frozen.
6. **Inter-page drift:** Add/delete/rename between pages changes the entry stream digest; the next page rejects stale continuation when metadata tuples are unchanged.
7. **Unchanged directory:** Stable bound revision; pagination continues when no drift occurs.
8. **Cancellation / shadow / escape:** Signal handling, shadow listings, and escape guards unchanged.

## Verification commands

```bash
npm run build
npm --prefix babel-cli run typecheck
npx tsx --import ./src/testinfra/register-no-ambient-inference.mjs --test \
  src/sandbox.directoryListingRevision.test.ts \
  src/sandbox.readRace.test.ts
```
