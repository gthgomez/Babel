<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: JSON Output Contract (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** All pipeline stages that emit JSON — Orchestrator, SWE Agent (plan JSON), QA Reviewer (verdict JSON), CLI Executor (tool call blocks)

---

## Purpose

Every pipeline stage in Babel emits structured JSON consumed by a Zod schema validator.
A parse failure at any stage triggers a waterfall retry and burns tokens. A schema mismatch
that passes parsing but fails semantic validation causes silent correctness drift downstream.

This skill enforces a pre-emission self-check that makes the model the first line of defense —
before the Zod layer, before the runtime retry, before the cascade.

The runtime already retries on parse failure. This skill prevents the failure from happening.

---

## Activation

This protocol runs immediately before you emit any JSON output. It does not replace the schema
defined by your stage role — it is a pre-flight check against that schema.

---

## Step 1 — JSON BOUNDARY CHECK

Before emitting, confirm:

1. Your output starts with `{`. If not — remove everything before it.
2. Your output ends with `}`. If not — the object is incomplete. Do not emit. Re-generate.
3. There is no text, prose, preamble, or explanation before `{` or after `}`.
4. There are no markdown code fences (` ```json ` or ` ``` `) wrapping the object.

**The pipeline injects your output directly into `JSON.parse()`. Text contamination is a hard failure.**

---

## Step 2 — REQUIRED FIELD AUDIT

Before emitting, mentally walk every field defined by your stage's output schema and confirm:

| Check | Rule |
|-------|------|
| All required fields present | Every non-optional field must exist in your output. |
| No field has value `null` when type is not nullable | If a field must be a string, it must be `""` not `null`. If it must be an array, it must be `[]` not `null`. |
| No field is missing entirely | Omitting a required field is not the same as setting it to `""`. Omitting fails parse. |
| Enum fields use exact values | If a field is `"PASS"` or `"REJECT"`, lowercase `"pass"` fails. Copy enum values exactly. |
| Integer fields are integers | `4.5` for a `z.number().int()` field is a schema error. Round to `4` — never emit a decimal for an integer field. |
| `plan_version` is always present | If your role involves a plan or revision, `plan_version` must be present and match the submitted plan's header. Never omit it. |

---

## Step 3 — SCHEMA-SPECIFIC INVARIANTS BY STAGE

Apply the relevant invariant set for your current pipeline stage:

### Orchestrator Stage
- `orchestrator_version` must be `"9.0"` (v9 lane) or `"8.0"` (v8 fallback). Never omit.
- `routing_confidence` must be a float `0.0–1.0`. Omit only if genuinely indeterminate. If present, never use a value outside `[0, 1]`.
- `compilation_state` must be `"uncompiled"` on router output. Never `"compiled"` at this stage.
- `prompt_manifest` must be an empty array `[]`. The resolver populates it — the router does not.
- `ambiguity_note` must be `null` when routing is unambiguous. Never leave as `""`.

### SWE Plan Stage
- `plan_version` is required. Start at `"v1"`, increment on every resubmission.
- `plan_type` must be one of the registered types (`MINIMAL_ACTION_SET`, `EVIDENCE_REQUEST`). No invented types.
- `task_summary`, `root_cause` and `verification` must be non-empty strings. Never `null`, never `""` for these fields.
- `minimal_action_set` must be an array, never `null`. Empty array only when `plan_type` is `EVIDENCE_REQUEST`.

### QA Verdict Stage
- `verdict` must be exactly `"PASS"` or `"REJECT"`. No other values.
- `overall_confidence` must be an integer `1–5`. Round down from decimals.
- `failures` must be an array. Empty `[]` on PASS. Never `null`.
- `failure_count` must equal `failures.length`. Mismatches cause downstream parse errors.
- `proposed_fix_strategy` must be `""` on PASS, not omitted or `null`.

### CLI Executor Stage
- Tool call blocks follow fixed formats defined in CLI Executor §4. Never invent field names.
- `exit_code`, `stdout`, `stderr` are received from the host — never generated. If you find yourself writing values for these fields, you are hallucinating. Stop.

---

## Step 4 — SELF-CORRECTION GATE

Before emitting, run this final check in order:

1. Does the first character of my output equal `{`? If not — trim.
2. Does the last character equal `}`? If not — my object is truncated. Do not emit. Regenerate.
3. Are there any decimal values in integer-typed fields? If yes — round down.
4. Are any required fields absent? If yes — add them with their zero values (`""`, `[]`, `0`, `false`).
5. Are any enum fields using non-canonical casing? If yes — correct to the exact enum value.
6. Is `plan_version` present wherever my role requires it? If not — add it.

Only after all six checks pass should you emit output.

---

## Hard Rules

1. A JSON output is not valid because it "looks right." It is valid only when it passes a mechanical schema check against every field in the contract.
2. "I'll let the runtime handle it" is not acceptable. The runtime retries on failure. Every retry wastes tokens and latency. Pre-emission hygiene is cheaper than post-emission recovery.
3. Never truncate a JSON object to save tokens. A truncated object is a parse error. If token pressure is real, reduce the verbosity of string field values — never omit structural fields.
4. Never wrap JSON in markdown. The pipeline is not a chat UI.
