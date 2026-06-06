<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Babel Runtime Contracts - v1.0

**Status:** ACTIVE
**Layer:** 00_System_Router / Contract Surface
**Pipeline Position:** Runtime contract anchor loaded before router, planning, QA, and executor schemas are interpreted.
**Purpose:** Define the canonical machine-facing artifacts shared by the router, planning, QA, and executor stages.
**Last Verified:** 2026-04-25

This file is the contract anchor. Prompt layers may extend these artifacts, but they must not replace them with local schemas.

---

## 1. Canonical Artifact Flow

```text
RouterSelection
  -> compiled prompt stack
  -> PlanEnvelope
  -> ExecutionSpec
  -> QAReview
  -> ExecutionReport
```

The critical separation is:

- `PlanEnvelope` is strategic and non-executable.
- `ExecutionSpec` is executable and may contain commands, full file content, exact write targets, and test invocations.

Do not make one artifact do both jobs.

---

## 2. RouterSelection

`RouterSelection` is emitted by `OLS-v9-Orchestrator.md`.

Required fields:

- `orchestrator_version`
- `target_project`
- `target_project_path`
- `analysis`
- `compilation_state`
- `instruction_stack`
- `resolution_policy`
- `platform_profile`
- `worker_configuration`
- `prompt_manifest`
- `handoff_payload`

Rules:

- `prompt_manifest` is empty while `compilation_state = "uncompiled"`.
- `instruction_stack` contains typed IDs only. Do not substitute physical prompt file paths.
- `behavioral_core_v10` and `behavioral_cognitive_micro_v7` are mandatory behavioral IDs.
- `behavioral_guard_v7` is conditional. Include it for write-capable, verified, autonomous, debugging, file-modifying, or contract-modifying work. Omit it for pure research, read-only critique, strategy, and product-audit outputs unless execution risk exists.

---

## 3. PlanEnvelope

`PlanEnvelope` is the canonical planning artifact.

Required fields:

- `plan_version`
- `objective`
- `known_facts`
- `assumptions`
- `risk_assessment`
- `minimal_action_set`
- `verification_method`

Conditional fields:

- `contract_assessment` for API, schema, type, event, env-var, billing, infrastructure, or public behavior changes.
- `confirmation_gate` when a human or orchestrator approval token is required.
- `domain_appendix` for domain-specific extensions.

Allowed content:

- objective, strategy, evidence status, risk, sequencing rationale, verification design, rollback or recovery strategy.
- target surfaces and contracts by name when they are needed to reason about blast radius.

Forbidden content:

- runnable CLI commands.
- SQL execution commands.
- code blocks, diffs, or generated implementation.
- full file content or exact patch bodies.
- placeholder executable steps that the executor would need to complete by guessing.

`minimal_action_set` in this artifact is strategic. It describes what must happen, not the exact physical tool payload.

---

## 4. ExecutionSpec

`ExecutionSpec` is the canonical executable artifact. It is generated only after the `PlanEnvelope` is approved or explicitly authorized by the pipeline.

Required fields:

- `execution_spec_version`
- `source_plan_version`
- `approved_changeset`
- `preconditions`
- `steps`
- `verification_criteria`
- `rollback_or_recovery`

Each executable step must include:

- `step_id`
- `intent`
- `tool`
- `target`
- `parameters`
- `verification`

Rules:

- Commands must be exact and bounded.
- File writes must name exact files and include complete final content, or a deterministic patch operation supported by the host.
- File writes must not contain ellipsis placeholders, omitted sections, or "existing code" comments.
- The executor may execute only what appears in `ExecutionSpec`.
- If `ExecutionSpec` lacks a required command, file body, path, or verification criterion, the executor must halt instead of improvising.

---

## 5. QAReview

`QAReview` is emitted by the adversarial reviewer.

Required fields:

- `verdict`: `PASS` or `REJECT`
- `reviewed_plan_version`
- `reviewed_execution_spec_version`
- `overall_confidence`
- `failures`
- `proposed_fix_strategy`

Rules:

- Review both `PlanEnvelope` and `ExecutionSpec` before `PASS`.
- A `PlanEnvelope` can be strategically sound while the `ExecutionSpec` is unsafe or underspecified. That is a `REJECT`.
- QA may name missing dimensions, but it must not generate code, commands, diffs, or implementation details.

---

## 6. ExecutionReport

`ExecutionReport` is emitted by the executor.

Required fields:

- `status`: `EXECUTION_COMPLETE`, `EXECUTION_HALTED`, or `ACTIVATION_REFUSED`
- `source_plan_version`
- `source_execution_spec_version`
- `steps_executed`
- `tool_call_log`
- `verification_results`
- `warnings`

Halted reports must also include:

- `pipeline_error.halt_tag`
- `pipeline_error.halted_at_step`
- `pipeline_error.condition`
- `pipeline_error.last_tool_output`

---

## 7. ConfirmationGate

Confirmation gates are data, not exact terminal strings.

Fields:

- `confirmation_required`: boolean
- `confirmation_token`: examples: `ACT`, `INFRA_ACT`, `APPROVE_PLAN`
- `approval_reason`: examples: `file_modification`, `stateful_production_change`, `contract_change`
- `next_stage`: examples: `execution_spec`, `qa_review`, `executor`

The renderer may turn these fields into a human-facing sentence. Prompt layers must not depend on a brittle exact final line.

---

## 8. Domain Appendices

Domains extend `PlanEnvelope.domain_appendix` instead of replacing the envelope.

Recommended appendix fields:

- DevOps: `change_classification`, `rollback_strategy`, `infra_bcdp`, `dry_run_gate`
- Android: `blast_radius`, `manifest_billing_fileprovider_checks`, `store_compliance_checks`
- Frontend: `uxdp_assessment`, `a11y_state_matrix`, `design_token_check`
- Product Audit: `claim_ledger`, `evidence_table`, `verdict_matrix`
- Compliance: `legal_claim_table`, `source_freshness`, `data_gaps`
- Python Backend: `async_pipeline_risks`, `validator_contracts`, `test_environment_check`
- LLM Router: `provider_contracts`, `sse_normalization_checks`, `pricing_registry_check`

---

## 9. Legacy Compatibility

Older runtime code may still refer to `SwePlan`, `MINIMAL_ACTION_SET`, or a JSON plan that contains tool steps. Treat that as a legacy merged artifact:

- The strategic fields map to `PlanEnvelope`.
- The executable tool steps map to `ExecutionSpec`.
- New prompt layers should use the split vocabulary even when the runtime still serializes a compatibility object.
