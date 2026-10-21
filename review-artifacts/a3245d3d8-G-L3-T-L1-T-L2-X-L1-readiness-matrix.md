# G-L3 / T-L1 / T-L2 / X-L1 readiness matrix (read-only)

**Authority revision:** `3245d3d8b01c9a3f0b1deebf4a58d86219828fd8` on `cursor/research-v2-post-review-settlement-fc31` (A combined runtime: B `2bde3a8` transport + durable Exa receipt line through `3245d3d8`).

**Machine-readable:** [`a3245d3d8-G-L3-T-L1-T-L2-X-L1-readiness-matrix.json`](./a3245d3d8-G-L3-T-L1-T-L2-X-L1-readiness-matrix.json)  
**Command log:** [`a3245d3d8-readiness-matrix-run.log`](./a3245d3d8-readiness-matrix-run.log)

## Summary

| Scenario | Offline readiness | Live acceptance (C) |
| --- | --- | --- |
| **G-L3** | Mission + outcomes + insufficiency fixture; G-L3 preflight **ready**; semantic partial e2e slice **pass** | **Unrun** — live python.org agreement/conflict; sequential discover iterations required |
| **T-L1** | Pins + two repo slots + technical-repository-file wiring **pass** | **Unrun** — live pinned GitHub tree + model |
| **T-L2** | PDF digest pin + arXiv cache tests **pass**; composed retrieval **pass** | **Unrun** — live ~2.2MB PDF fetch + synthesis |
| **X-L1** | `cancel-resume-once` CLI + cancel/resume store tests **pass** | **Unrun** — live cancel→resume with production model |

## Not repeated this turn

- One real Exa search: [`exa-lite-live-connectivity-receipt-d7236721.json`](./exa-lite-live-connectivity-receipt-d7236721.json) @ `d7236721` (ancestor of matrix SHA).

## Configuration note (not matrix base)

`ba45f328` makes **`exa_lite`** the default admitted search provider with DDG fallback; matrix preflight @ `3245d3d8` still observed **`duckduckgo_html_fallback`** unless env overrides.

## Advance (2026-10-21)

Corrections and new offline proofs: [`ba45f328-readiness-matrix-advance.json`](./ba45f328-readiness-matrix-advance.json)

- **G-L3:** removed erroneous “separate discover iterations” blocker; both python.org `selected_web_refs` fetch in one loop @ ba45.
- **T-L1:** LangGraph pin fixed (`3cd57c03…`); default 8-word discover query **0 hits**; use `--discover-query "research v2 persistence"` for Babel; single-query / two-pin limitation documented.
- **T-L2:** **BLOCKED** by 200KB host clamp vs 2.2MB paper (not merely unrun).
- **X-L1:** owner lifecycle harness test (not `cancel-resume-once` fixture journey).
