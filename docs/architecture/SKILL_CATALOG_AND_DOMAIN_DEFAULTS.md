# Skill Catalog Loading And Domain Default Policy

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
This document records PR3 routing discipline for `skill_catalog` and `default_skill_ids`
on domain architects. It complements `SKILL_SYSTEM_BRIDGE.md` (prompt vs package surfaces).

## `skill_catalog` (secondary index)

| Field | Policy |
|-------|--------|
| **File** | *(eliminated 2026-06-29 — `prompt_catalog.yaml` is now the sole catalog)* |
| **Catalog id** | *(removed)* |
| **Layer** | *(was `config`)* |
| **Selection** | *(was `discoverable` — the JIT skill selection use case is now served directly from `prompt_catalog.yaml`)* |
| **Token budget** | *(reclaimed ~200 tokens)* |

### When to load

Load `skill_catalog` only when:

- the operator or router needs the full skill id → path registry for JIT selection, or
- a manifest explicitly includes `skill_catalog` in `instruction_stack.skill_ids` / config ids.

Do **not** treat it as part of the default backend, frontend, Android, or research stacks.
`prompt_catalog.yaml` remains the canonical registry; `Skill-Catalog.yaml` is a generated mirror.

### When not to load

- Ordinary implementation tasks where domain `default_skill_ids` and explicit `skill_ids` suffice.
- Token-budget-sensitive previews where +5k tokens would crowd out behavioral OS and domain shells.

## Domain `default_skill_ids` policy

Defaults should answer: *"What does almost every task in this domain need?"*
Not: *"What might occasionally help?"*

| Domain | Default skills | Rationale |
|--------|----------------|-----------|
| `domain_swe_backend` | ts_zod, supabase_pg, evidence_gathering, bcdp_contracts | Core backend contracts + evidence |
| `domain_swe_frontend` | react_nextjs, a11y_design, evidence_gathering, bcdp_contracts | Core UI stack + evidence |
| `domain_compliance_gpc` | evidence_gathering, compliance_evidence_audit | Audit-first compliance |
| `domain_research` | evidence_gathering, claim_extraction_ledger | Research ledger without product-reality overlay |
| `domain_product_audit` | evidence_gathering, claim_extraction_ledger, product_reality_audit | Full claim/reality stack |
| `domain_devops` | log_analysis, evidence_gathering, bcdp_contracts | Ops logs + contracts |
| `domain_llm_router` | evidence_gathering, bcdp_contracts | Router contracts only; SSE/deno skills are explicit opt-in |
| `domain_python_backend` | log_analysis, evidence_gathering, bcdp_contracts | Python pipelines without ops_observability by default |
| `domain_android_kotlin` | app_classification, testing_obligation, evidence_gathering, bcdp_contracts, jetpack_compose | Slim Android default; full test matrix via `skill_android_test_enforcement_deep` |
| `domain_godot_game_dev` | godot_gdscript_arch, evidence_gathering, bcdp_contracts | Core Godot arch without theme/data-resource sprawl |

### Explicit opt-in examples (not defaults)

- **Android full test matrix:** `skill_android_test_enforcement_deep` (expands obligation, strategy, unit, screenshot, instrumented)
- **LLM streaming work:** `skill_sse_streaming`, `skill_deno_edge_functions`
- **Research → product reality:** `skill_product_reality_audit`
- **Python ops depth:** `skill_ops_observability`
- **Godot UI/theme:** `skill_godot_ui_theme`, `skill_godot_data_resources`
- **X launch/comms:** `skill_x_marketing_manager` and related X skills (discoverable only)

## X marketing skills

The four X governance skills stay **discoverable** with **no** `default_for_domains` and **no**
inclusion in any domain `default_skill_ids`. They are launch/comms overlays, not daily coding defaults.

## Changing defaults

Before editing `default_skill_ids`:

1. Run `tools/test-domain-default-policy.ps1`
2. Run `npm --prefix babel-cli run test:orchestrator-routing` (or `stackResolver.tokenBudget.test.ts`)
3. Leave a short catalog tuning note per `02_Skills/Governance/Babel-Catalog-Tuning-v1.md`

## Validation commands

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
powershell -ExecutionPolicy Bypass -File .\tools\audit-skill-disk-drift.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-domain-default-policy.ps1
npm --prefix babel-cli test -- --test-name-pattern "heavy specialized skills"
```
