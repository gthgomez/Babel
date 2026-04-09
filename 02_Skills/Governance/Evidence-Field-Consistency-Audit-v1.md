# Evidence-Field-Consistency-v1

Use this skill when a product exposes the same event or decision across multiple layers and the values disagree.

Best fit:
- API response says one thing, DB row says another
- DB row says one thing, RPC/view says another
- RPC/view says one thing, UI label says another
- identifiers drift between request id, event id, signal id, or row id

Core rule:
- Audit the full chain for one concrete event end to end before changing code.

Workflow:
1. Capture one real event with a stable anchor.
   - Prefer a concrete id such as `signal_id`, `request_id`, `alert_id`, `job_run_id`, or `subscription_id`.
2. Compare the same event across four layers:
   - runtime response
   - persisted table row
   - derived RPC/view/query surface
   - user-facing UI label/rendering
3. Record mismatches field by field.
   - value
   - expected meaning
   - actual meaning
   - first layer where drift appears
4. Classify the defect:
   - `write_path_bug`
   - `read_model_bug`
   - `ui_mapping_bug`
   - `deployment_drift`
   - `schema_cache_or_partition_drift`
5. Fix the earliest broken layer possible.
   - If persisted row is wrong, fix write path first.
   - If persisted row is right but RPC/view is wrong, fix derived surface next.
   - If data surfaces are right and UI is wrong, fix label mapping last.
6. Re-run the same event after the fix and verify all four layers agree.

Required checks:
- confirm whether live runtime matches repo code
- confirm partitions inherit required columns/defaults/grants
- confirm derived SQL functions expose the canonical fields
- confirm fallback logic in UI does not silently rewrite correct values into wrong labels

Red flags:
- response id does not match persisted row id
- `null`/default values survive despite non-null runtime inputs
- request metadata has less information than the runtime had available
- UI fallback labels contradict raw persisted fields
- bug appears only in production after code was already “fixed” in repo

Outputs:
- one anchor id
- one layer-by-layer mismatch ledger
- one root-cause classification
- one minimal fix
- one post-fix verification ledger
