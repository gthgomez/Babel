<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Evidence Gathering Protocol (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_swe_frontend`, `domain_devops`, `domain_compliance_gpc`

---

## Purpose

The Evidence Gate is the #1 cause of QA rejection. Writing a plan against a file you have not read
is a protocol violation — not a shortcut. This skill converts the Guard's reactive stop into a
proactive mandatory phase that completes before any plan section is authored.

A plan built on inferred file contents is not a plan. It is a guess with structure.

---

## Activation

This protocol runs ONCE, at the start of every task, before any OBJECTIVE, KNOWN FACTS, or
MINIMAL ACTION SET is written. It is not optional. It is not skippable for "simple" tasks.

If the task is an EVIDENCE_REQUEST (its sole purpose is gathering context), complete Step 1 only
and proceed. Do not run Steps 2–3 for read-only evidence tasks.

---

## Step 1 — FILE INDEX

Enumerate every file that the task will touch, reference, or need to understand.

For each file:

| File | In Context? | Action |
|------|-------------|--------|
| `[path]` | YES | No action needed. |
| `[path]` | NO — file access available | Read it now before continuing. |
| `[path]` | NO — no file access | **HALT.** Output the block below. |

**HALT output (copy exactly when any file is missing and no file access exists):**

```
EVIDENCE MISSING
────────────────
Missing: [filename or path]
Reason:  File content is not in context and environment has no file access.
Impact:  Cannot write a safe plan without current content.

Required action: Paste the relevant sections of [filename] before I proceed.
I will not infer, approximate, or plan against unseen content.
```

Do not write OBJECTIVE or any plan section until all files in the index are confirmed IN_CONTEXT.

---

## Step 2 — SCHEMA AND TYPE INDEX

For every interface, Zod schema, TypeScript type, API contract, or database table the plan
will reference or modify:

| Contract | Type | In Context? | Action |
|----------|------|-------------|--------|
| `[name]` | [interface \| schema \| table \| API] | YES | No action. |
| `[name]` | [interface \| schema \| table \| API] | NO — accessible | Read or query it now. |
| `[name]` | [interface \| schema \| table \| API] | NO — inaccessible | Treat as `[EVIDENCE-GATE]`. |

**Rule:** A Zod schema you have not read is not a schema you can safely modify. A TypeScript
interface you have not seen is not one you can classify as COMPATIBLE or BREAKING.

If any schema or type is inaccessible, apply the same HALT output from Step 1.

---

## Step 3 — CONSUMER INDEX (required if any contract will be modified)

If the task involves modifying a contract (schema, interface, API shape, component props,
environment variables), enumerate all known consumers before writing the plan.

**When `skill_bcdp_contracts` is also loaded:** This Step 3 output is the input to BCDP Step 1.
Complete this table first, then hand off to BCDP for impact classification and safety artifacts.
Do not run consumer enumeration again inside BCDP Step 1 — use this table as the starting list.

For each consumer:

| Consumer | Location | Visibility |
|----------|----------|------------|
| `[file or service]` | [path or external] | IN_CONTEXT \| NOT_VERIFIED \| EXTERNAL |

**NOT_VERIFIED** means: the consumer exists but you cannot confirm its current usage from
available context. This is not a blocker — but you must declare it explicitly and include
it as an ASSUMPTION in the plan.

**EXTERNAL** means: a consumer outside this repository (webhook, published SDK, third-party
integration). External consumers must be treated as BREAKING-risk until proven otherwise.

If consumer enumeration is incomplete, do not claim it is complete. State:
`Consumer list is NOT_VERIFIED — additional consumers may exist outside visible context.`

---

## Evidence Receipt

When Steps 1–3 complete with no HALT conditions, output exactly this line before writing the plan:

```
EVIDENCE RECEIPT
────────────────
Files confirmed in context:    [n]
Schemas confirmed in context:  [n]
Consumers identified:          [n] (IN_CONTEXT: [n], NOT_VERIFIED: [n], EXTERNAL: [n])
Status: EVIDENCE COMPLETE — proceeding to plan.
```

This receipt is machine-parseable. Do not omit it, paraphrase it, or combine it with plan content.

---

## Hard Rules

1. Never write a KNOWN FACTS entry that references a file you have not read in this session.
2. Never write a MINIMAL ACTION SET step that touches a schema you have not confirmed in context.
3. Never claim consumer enumeration is exhaustive when any consumer is marked NOT_VERIFIED.
4. "The file probably looks like X" is not evidence. It is an assumption — and it must be labeled as one.
5. If the task was triggered by an error message or log output, that output is required evidence.
   If it is not in context, request it before planning.
