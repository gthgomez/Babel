# Archive Drift Report — Deprecated Behavioral Version IDs

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Date:** 2026-07-03
**Scope:** Read-only scan of `docs/archive/` and `02_Skills/archive/`
**Scanner:** `grep -rn` for deprecated IDs: `behavioral_cognitive_micro_v7`, `behavioral_guard_v7`, `OLS-v7-Cognitive`, `OLS-v7-Guard`, plus the active `behavioral_core_v10` / `OLS-v10-Core` (included for completeness).

---

## Summary

| Location | Files with matches | Total match lines |
|---|---|---|
| `docs/archive/` | 6 files | 27 lines |
| `02_Skills/archive/` | 2 files | 3 lines |
| **Total** | **8 files** | **30 lines** |

---

## Per-File Breakdown

### `docs/archive/`

| File | Deprecated IDs referenced | Notes |
|---|---|---|
| `Babel_Stack_Frontend_Task.md` | `OLS-v7-Guard-AUTO.md` | Historical reference to an old guard file path. |
| `BABEL_PHASE4_RELIABILITY_REPORT_2026-04-03.md` | `behavioral_cognitive_micro_v7`, `behavioral_guard_v7` | Retrospective report cataloging reliability issues; names the IDs that were live at the time. |
| `BABEL_STANDARDS_AUDIT_IMPLEMENTATION_PLAN_2026-04-25.md` | `OLS-v10-Core-Universal.md`, `OLS-v7-Guard-Auto.md`, `OLS-v7-Core`, `behavioral_core_v10`, `OLS-v7-Cognitive-Micro` | An implementation plan that describes the v7-to-v10 migration. References both old and new IDs as part of the upgrade narrative. Also references the then-active `behavioral_core_v10` (not deprecated). |
| `Babel_Startup_Sequence.md` | `OLS-v7-Guard-AUTO.md` | Historical startup sequence referencing an old guard file path. |
| `BABEL_TUI_REFACTOR_AGENT_PLAN_2026-04.md` | `OLS-v7-Core`, `OLS-v7-Guard` | Archived agent plan that opens with `OLS-v7-Core` and `OLS-v7-Guard` as binding behavioral rules. |
| `WebLLM-Contextdoc.md` | `OLS-v7-Guard-Auto.md`, `OLS-v7-Core-Universal.md` | Archived context document showing the behavioral OS stack as it existed under v7. |

### `02_Skills/archive/`

| File | Deprecated IDs referenced | Notes |
|---|---|---|
| `Governance/Autonomous-Agent-State-Machine-v1.md` | `OLS-v10-Core-Universal.md` (active), `OLS-v7-Guard-Auto.md` | Archived skill describing the behavioral OS composition at the time of archival (v10 core + v7 guard). |
| `Governance/Context-Budget-Defense-v1.md` | `OLS-v10-Core-Universal.md` (active), `OLS-v7-Guard-Auto.md` | Archived skill describing behavioral OS layer composition. |

---

## Surprising Findings

**None.** All references are expected in historical/archived context:

1. Migration plans (e.g., `BABEL_STANDARDS_AUDIT_IMPLEMENTATION_PLAN`) naturally cite both old and new IDs as part of the upgrade narrative.
2. Retrospective audit reports (e.g., `BABEL_PHASE4_RELIABILITY_REPORT`) name the IDs that were in effect during the period under analysis.
3. Archived agent plans and context documents (e.g., `BABEL_TUI_REFACTOR_AGENT_PLAN`, `Babel_Startup_Sequence`, `WebLLM-Contextdoc`) reference the behavioral versions that were live when they were written.
4. Archived skills reference the behavioral OS layer stack that was current at archival time.

No reference points to an ID that never existed — all six deprecated IDs (`behavioral_cognitive_micro_v7`, `behavioral_guard_v7`, `OLS-v7-Cognitive`, `OLS-v7-Cognitive-Micro`, `OLS-v7-Core`, `OLS-v7-Guard`) are known historical behavioral versions.

---

## Policy Note

Per the revamp policy, archived files are historical snapshots and have not been modified. This scan is informational only — no changes were made to any files.

---

## Raw Grep Output

### `docs/archive/`

- **Babel_Stack_Frontend_Task.md** — 1 match (`OLS-v7-Guard-AUTO.md`)
- **BABEL_PHASE4_RELIABILITY_REPORT_2026-04-03.md** — 4 matches (`behavioral_cognitive_micro_v7`, `behavioral_guard_v7`)
- **BABEL_STANDARDS_AUDIT_IMPLEMENTATION_PLAN_2026-04-25.md** — 17 matches (`OLS-v10-Core-Universal.md`, `OLS-v7-Guard-Auto.md`, `OLS-v7-Core`, `behavioral_core_v10`, `OLS-v7-Cognitive-Micro`)
- **Babel_Startup_Sequence.md** — 1 match (`OLS-v7-Guard-AUTO.md`)
- **BABEL_TUI_REFACTOR_AGENT_PLAN_2026-04.md** — 1 match (`OLS-v7-Core`, `OLS-v7-Guard`)
- **WebLLM-Contextdoc.md** — 3 matches (`OLS-v7-Guard-Auto.md`, `OLS-v7-Core-Universal.md`)

### `02_Skills/archive/`

- **Governance/Autonomous-Agent-State-Machine-v1.md** — 2 matches (`OLS-v10-Core-Universal.md`, `OLS-v7-Guard-Auto.md`)
- **Governance/Context-Budget-Defense-v1.md** — 1 match (`OLS-v10-Core-Universal.md`, `OLS-v7-Guard-Auto.md`)
