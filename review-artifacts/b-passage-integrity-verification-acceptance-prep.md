# Passage integrity verification — B acceptance prep (not implemented)

**Status:** preparation only; **not** acceptance evidence.  
**Transport baseline preserved:** `e94e7a54` governed HTTP diagnostics / tree search handoff on `#404` — independent review; no live diagnostic.

## Authority (Agent A)

Production uses one **optional** `PassageRecord.integrity_verification` contract on the existing passage model. Verification is created by the **actual profile extractor** via existing `appendPassage`, bound to `source_fetch_owner` and **exact successful** `source_fetch` attempt lineage.

B **does not** introduce a parallel verifier port, handoff API, stub outcomes, or new store events / model fields. B reciprocal acceptance tests land **after** A’s published dependency union on this branch.

## Receipt bindings (required when A emits verification)

The verification receipt must bind (scalar identifiers only in public artifacts):

| Field | Role |
| --- | --- |
| `source_id` | Admitted source |
| `source_revision_id` | Revision at extract time |
| `content_hash` | Whole-source content hash |
| `byte_length` | Admitted decoded byte length at verification |
| `extraction_version` | Extractor that created the passage |
| `passage_id` | Passage row |
| `text_hash` | Passage `text_ref.text_hash` |
| `locator` | Passage locator (kind + coordinates) |
| `admitted_representation` scope | What bytes/locator slice was verified (whole-source vs excerpt) |
| `excerpt_only_retention` | Visibility / retention policy acknowledgment |

**Host-only:** verification is attached when representation exists at the real extractor; no separate verifier database or model-output field.

**Honesty:** allowlisted HTTP / JSON message fields do **not** prove absence of secrets in passage text; semantic `source_integrity` remains distinct from model semantic judgment.

## Historical fixtures (G-L2 / G-L3)

- Unchanged **original-derived** / paid-run fixture JSON: findings remain `source_integrity: not_checked` with **no** retroactive `integrity_verification`.
- Any newly generated verification in B tests must use a **separately labeled deterministic replay** mission/plan revision, never attributed to historical live diagnostics.

## Scope limitation

Complete terminal state is reachable only when **all existing gates** genuinely pass. This work does **not** certify model semantic correctness or independent multi-source corroboration.

## 7. Required acceptance tests (B-owned; pending A union)

**Harness:** real runner, real adapters, `DurableResearchStore`; stub **network/model only**.

### Positive

1. One complete source, real supported answer, answered coverage.
2. Actual adapter creates `integrity_verification`; `source_fetch` settles `succeeded`; finding becomes `valid`.
3. Report reaches `complete`.
4. Close/reopen preserves verification receipt and integrity result.

### Negative (isolated — one defect per case)

5. Persisted passage `text` altered without updating `text_hash`.
6. `text` and `text_hash` altered but verification still bound to original material.
7. `locator` altered while `text`/`text_hash` unchanged.
8. Substitute another revision, source, or fetch attempt.
9. Verification present but owning fetch cancelled/failed.
10. Receipt persistence fails after passage write.
11. Writer replacement before persistence completes.
12. Legacy passage without `integrity_verification`.
13. Complete verified source but semantic coverage partial → terminal not falsely `complete`.
14. Verified excerpt from truncated source remains partial / not whole-source complete.

### Format controls

15. HTML heading occurrences (actual adapter path).  
16. Technical `byte_offset` locator.  
17. Plain-text `line_range`.  
18. Real PDF `page` locator.

### Lineage isolation

19. Duplicate `passage_id` across different fetch attempts — selection must not reuse another attempt’s receipt.

**C:** source-only live diagnostic remains parent/C-owned after review; not executed here.
