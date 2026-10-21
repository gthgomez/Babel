# T-L1 LangGraph pin handoff correction

**Status:** additive correction; does not rewrite prior integration commit history.

## Prior handoff error (`b317d9a0` prose)

Integration receipt and PR text stated the T-L1 LangGraph pin remained `d2c584a238566d2bfd7d28e053a94e3a9af1ffd7`. That SHA is **invalid** on official GitHub (`GET .../commits/d2c584…` → HTTP 422). It is **not** an accepted campaign pin and must not be cited for verified path/size diagnostics.

## Corrected accepted pin (B-verified)

| Field | Value |
|-------|--------|
| Repository | `langchain-ai/langgraph` |
| Commit | `3cd57c038ad827d05f80c6488adea9994156c58c` |
| Git tree | `a8aa3b138b6036c25331712af8ed8b3f0a4a0fda` |
| Per-pin `discover_query` | `pregel checkpoint` |
| Scoped first hit (reviewed) | `libs/langgraph/langgraph/pregel/_checkpoint.py` (20417 bytes at this pin) |

Authoritative copies: `T-L1-mission.json` (`source_policy.selected_repository_refs`) and `T-L1-T-L2-PINNED-VERSIONS.json` (`reference_repository` + `pin_resolution`).

Babel target pin unchanged: `e912c2f3320de0b6e1c9ff85b95b0f74d8b5323c` with `persistence durableresearchstore.ts` → `babel-cli/src/research/v2/persistence/durableResearchStore.ts` (8305 bytes; B-verified scoped diagnostic, separate from the invalid LangGraph SHA).
