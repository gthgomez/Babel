<!--
status: ACTIVE
last_verified: 2026-07-24
role: INDEX
-->
# Docs — Audits

Point-in-time audits and corrected plans. **Implementation truth is always code + tests.** Prefer the CANONICAL rows below for “what’s left.”

## Canonical (plan from these)

| Doc | Role | What’s left |
|-----|------|-------------|
| [BABEL_VS_CODEX_GROK_OPENCODE_HARNESS_TEARDOWN_2026-07-24.md](./BABEL_VS_CODEX_GROK_OPENCODE_HARNESS_TEARDOWN_2026-07-24.md) | **Four-way harness teardown** (Babel home vs Codex / Grok / OpenCode) + catch-up waves W0–W7 + test contracts | W0 harness fidelity → W1 reliability → install/BYOM → ACP/attach → sandbox → subagents → TUI polish |
| [BABEL_VS_GROK_CLI_UPGRADE_AUDIT_2026-07-16.md](./BABEL_VS_GROK_CLI_UPGRADE_AUDIT_2026-07-16.md) | **Grok-class product upgrade** (comparison + U0–U5 implementation waves) | U0–U1 in the relevant PR; then U2 plan/permissions → U3 subagents/skills |
| [BABEL_CODING_AGENT_STATE_2026-07-08.md](./BABEL_CODING_AGENT_STATE_2026-07-08.md) | Harness + chat product residual | SWE quality, GOV-D pass-rate recovery, optional phase tools A/B, T4.2 from TUI matrix |
| [TUI-COMPETITIVE-CORRECTED-PLAN-2026-07-09.md](./TUI-COMPETITIVE-CORRECTED-PLAN-2026-07-09.md) | Post–A–E TUI residual plan | **G1–G7 complete**; optional O1–O6 only |
| ../../babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md | Long-running TUI matrix / score | D2 protocol tail + optional polish |

## Evidence / closeout (do not treat as open backlogs)

| Doc | Role |
|-----|------|
| [BABEL_PRESERVATION_GAP_AUDIT_2026-07-10.md](./BABEL_PRESERVATION_GAP_AUDIT_2026-07-10.md) | Preservation & continuity gap audit |
| [VOICE_DICTATION_BLUEPRINT_AUDIT_2026-07-08.md](./VOICE_DICTATION_BLUEPRINT_AUDIT_2026-07-08.md) | Voice blueprints vs Babel TUI surface (YELLOW — scope mismatch) |
| [CLAUDE_CODE_VS_BABEL_GAP_ANALYSIS_2026-07-13.md](./CLAUDE_CODE_VS_BABEL_GAP_ANALYSIS_2026-07-13.md) | Phase-gate structural lessons (still valid) |

## Related (diagnosis / peer path — do not re-implement closed layers)

| Doc | Role |
|-----|------|
| ../archive/plans/BABEL_VS_GROK_CLI_GAP_AND_FIX_PLAN_2026-07-12.md | L0–C diagnosis — **implementation complete**; plan from 2026-07-16 upgrade audit |
| [../plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md](../plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md) | Tier D–F validate path — absorbed into upgrade audit **Wave U0–U1** where overlapping |
| ../status/IMPLEMENTOR_ROADMAP_W0_W1_PROGRESS_2026-07-15.md | W0–W3 preconditions for upgrade waves |

## Archived Audits (`../archive/audit/`)

Do not schedule work from these gap lists. Paths are under `docs/archive/audit/`.

| Doc | Superseded by / role |
|-----|----------------------|
| TUI-COMPARISON-AUDIT-2026-07-09.md | Corrected plan (gap list ~30% error) |
| TUI-COMPETITIVE-COMPARISON-2026-07-09.md | Corrected plan comparison |
| BABEL_CHAT_MODE_AUDIT_2026-06-28.md | Coding-agent state + TUI competitive reference |
| BABEL_CHAT_PROMPT_COMPILATION_OLS-MCC-v4.5_2026-06-28.md | Point-in-time prompt stack audit (re-verify before acting) |
| BABEL_A03_FALSE_COMPLETE_ROOT_CAUSE_2026-07-13.md | A03 root-cause snapshot |
| BABEL_A08_SMOKE_POST_ABC_2026-07-13.md | Post-ABC smoke snapshot |
| BABEL_SELECTIVE_REMEASURE_POST_E_2026-07-13.md | Post-E remeasure snapshot |
| BABEL_PAST_RUNS_INVESTIGATION_2026-07-12.md | Past-runs investigation; operational prompt moved to guides |

## Hygiene rules

1. When a gap ships, update the **corrected plan tracking table** and this README if status changes.
2. Do not revive “missing autocomplete / dialogs / keymap / DECSTBM / resize-reflow” from the original comparison — those claims are false or closed.
3. Harness work and TUI work are separate layers; do not mix gap lists blindly (see coding-agent state §1).
