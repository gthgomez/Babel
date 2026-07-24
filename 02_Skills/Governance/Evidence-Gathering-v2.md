<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Evidence Gathering Protocol (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** v1.1 (compiled min only — this is the first full-source version)
**Pairs with:** `skill_bcdp_contracts`, `domain_swe_backend`, `domain_swe_frontend`, `domain_devops`, `domain_compliance_gpc`, `ols-compiler` (hardening), `ops-observability` (evidence tracing)
**Activation:** Load before writing any plan that references files, schemas, APIs, execution surfaces, or external consumers. This is the "measure twice, cut once" of Babel planning — you cannot write a safe plan against unseen content.

---

## Purpose

A plan written against assumed file content is a plan that will fail at execution time — often silently, after several steps have already run, leaving partial state. "The file probably looks like X" is not evidence. It is an assumption — and assumptions must be labeled, minimized, and verified before they become plan steps.

This skill enforces a structured evidence-gathering pass before any plan is written: index every file, schema, execution surface, consumer, and MCP-accessible resource the plan will touch. HALT on missing evidence rather than approximate.

---

## Step 1 — FILE INDEX

For every file the plan will read or modify:

| Path | In Context? | Action |
|------|------------|--------|
| `[path]` | YES | No action needed |
| `[path]` | NO — file access available | Read it now before continuing |
| `[path]` | NO — no file access | **HALT.** Output the block below |

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

---

## Step 2 — SCHEMA AND TYPE INDEX

For every schema, type, interface, table, or API contract the plan will touch:

| Name | Kind | In Context? | Action |
|------|------|------------|--------|
| `[name]` | [interface / schema / table / API] | YES | No action |
| `[name]` | [interface / schema / table / API] | NO — accessible | Read or query it now |
| `[name]` | [interface / schema / table / API] | NO — inaccessible | Treat as `[EVIDENCE-GATE]` |

**Rule:** A Zod schema you have not read is not a schema you can safely modify. A TypeScript interface you have not confirmed is an assumption, not a contract. If any schema or type is inaccessible, apply the same HALT output from Step 1.

---

## Step 2.5 — EXECUTION SURFACE INDEX

For every runtime dependency the plan assumes:

| Surface | Kind | In Context? | Action |
|---------|------|------------|--------|
| `[scheduler / cron / trigger]` | execution | YES | No action |
| `[env var / secret / webhook target]` | runtime dependency | NO — accessible | Read now |
| `[runbook / operator page / queue store]` | operational surface | NO — accessible | Read now |
| `[surface]` | execution / runtime / operational | NO — inaccessible | Treat as `[EVIDENCE-GATE]` |

**Rule:** If a plan references a cron, portal, queue, env var, webhook, or runbook you have not confirmed — you do not know whether the plan is compatible with the runtime surface. Confirm before writing.

**For operational surfaces, also confirm:**
- The execution ledger table or run history surface
- The alert table or alert view used by operators
- The acknowledge/resolve path if the workflow expects human closure
- The escalation signal path, not just the initial alert-creation path

**For auth/RLS surfaces, also confirm:**
- The parent table grants
- The current active partition grants
- The RLS policy text currently live
- Whether remote migration state matches local migration state
- Whether schema cache / PostgREST visibility is relevant
- Whether the runtime is using a JWT-scoped client or service-role client

---

## Step 3 — CONSUMER INDEX

Required if any contract (API, schema, export) will be modified.

**When `skill_bcdp_contracts` is also loaded:** This Step 3 output is the input to BCDP Step 1.

| Consumer | Status | Impact |
|----------|--------|--------|
| `[name]` | IN_CONTEXT / NOT_VERIFIED / EXTERNAL | [what breaks if this contract changes] |

**NOT_VERIFIED** means: the consumer exists but you cannot confirm its current usage from available context. This is not a blocker — but you must declare it explicitly and include the uncertainty in the plan's RISKS section.

**EXTERNAL** means: a consumer outside this repository (webhook consumer, published SDK, third-party integration). External consumers must be treated as BREAKING-risk until proven otherwise.

**Consumer categories to check:**
- Support teams, compliance operators, dashboards, schedulers
- External providers, incident responders consuming deduplicated alerts or run ledgers
- Deployment/runtime layers (Vercel, Supabase Edge Functions, PostgREST schema cache) when they can preserve stale behavior after code changes

---

## Step 2.7 — MCP CONTEXT INDEX

For every external resource accessible via MCP:

| Resource | MCP Server | In Context? | Action |
|----------|-----------|------------|--------|
| `[repo-issue / pr]` | `github` | NO | Query `get_issue` or `list_pull_requests` |
| `[db schema / logs]` | `sqlite / postgres` | NO | Query `describe_table` or `search_logs` |
| `[docs / wiki]` | `mcp-docs` | NO | Query `search_docs` or `get_resource` |
| `[tool / script]` | `mcp-tools` | NO | Execute specialized tool for diagnostic evidence |

**Rule:** Never approximate external state (PR comments, Jira tickets, database row counts) if an MCP server is available to fetch the ground truth.

---

## Evidence Receipt

When Steps 1–3 complete with no HALT conditions, output exactly this line before writing the plan:

```
EVIDENCE RECEIPT
────────────────
Files confirmed in context:    [n]
Schemas confirmed in context:  [n]
Execution surfaces confirmed:  [n]
MCP Resources gathered:        [n]
Consumers identified:          [n] (IN_CONTEXT: [n], NOT_VERIFIED: [n], EXTERNAL: [n])
Status: EVIDENCE COMPLETE — proceeding to plan.
```

---

## Rule 8 — Hook and Import Contract Reads (Frontend Tasks)

For frontend tasks involving component rewrites, these reads are mandatory before any `file_write`:

| Read | When Required |
|------|---------------|
| Every hook the component calls (`useSites`, `useAccount`, etc.) | Always |
| `@/lib/api.ts` sections covering interfaces the component uses | When component imports from `@/lib/api` |
| `@/lib/tier-utils.ts` | When component calls any tier utility function |
| The component file being rewritten (its current content) | Always — before any `file_write` on an existing file |

**Why this rule exists:** Hook return shapes, interface field names, and utility function return types are not guessable. A `useSites()` hook might return `{ data, isLoading, error }` (TanStack Query) or `{ sites, refresh }` (custom hook). Import path inference without reading the source is fabrication.

**The plan is invalid if any `file_write` on a component appears before the hook reads.** Do not treat project overlay API documentation as a substitute for reading the source.

---

## Hard Rules

1. Never write a KNOWN FACTS entry that references a file you have not read in this session.
2. Never write a MINIMAL ACTION SET step that touches a schema you have not confirmed in context.
3. Never claim consumer enumeration is exhaustive when any consumer is marked NOT_VERIFIED.
4. "The file probably looks like X" is not evidence. It is an assumption — and it must be labeled as one.
5. If the task was triggered by an error message or log output, that output is required evidence.
6. A runtime dependency you have not confirmed is evidence missing, not implementation detail.
7. A live auth or RLS problem is not fully understood until both code intent and remote effective grants/policies are checked.
8. When porting from one stack to another, never assume the source repo mirrors the target stack's file layout. A Python source repo is not an Android repo; a web repo is not a Kotlin package tree. Read the actual source files first, then map them into target files.
9. **New in v2.0:** Every HALT on missing evidence must be logged as an observable event. Ops-Observability OBSERVE mode should track evidence-gate frequency to identify skills or domains with chronically missing context.

---

## Boundaries — Do Not Overstep

- **This skill gathers evidence — it does not write plans.** The EVIDENCE RECEIPT is a gate before planning, not a plan itself.
- **This skill identifies missing evidence — it does not fabricate it.** HALT, don't guess. A plan delayed by missing evidence is better than a plan built on assumptions.
- **This skill does not replace MCP tool documentation.** It tells you to use MCP tools for ground truth. The specific tool syntax lives in the MCP server's documentation.
- **This skill does not guarantee completeness.** It indexes what the plan explicitly references. Implicit dependencies (transitive imports, indirect consumers) may still be missed. The NOT_VERIFIED consumer status exists for this reason.

---

## Failure Behavior of This Skill

- **File exists but is too large to read in full (>2000 lines):** Read the first 200 and last 100 lines. Index function signatures and exports. Flag the unscanned middle as PARTIAL_READ. Proceed only if the plan targets functions/sections you've confirmed.
- **Schema is in a format you can't parse (binary, compiled, minified):** Flag as UNREADABLE. Treat as `[EVIDENCE-GATE]`. Do not guess the schema from usage patterns.
- **MCP server is unavailable for a resource that requires ground truth:** Flag as MCP_UNAVAILABLE. Proceed with caution — mark all claims about that resource as [INFERRED] or [ASSUMED].
- **Consumer enumeration finds 20+ consumers:** This is a high-impact change. Flag as BROAD_IMPACT. Recommend a phased rollout plan with per-consumer verification.
- **Self-test:** This protocol should be tested by running it against a known task with deliberately withheld files and verifying it HALT-s on every missing file rather than proceeding with assumptions.

---

## Strategic Next Move

After every EVIDENCE RECEIPT or HALT, end with exactly one strategic next-move question: if HALT, ask the human to provide the missing evidence; if EVIDENCE COMPLETE, confirm readiness to proceed to planning.

---

## References

- `skill_bcdp_contracts` — Step 3 output feeds BCDP Step 1 for consumer impact analysis.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening the evidence-gathering workflow against discovered edge cases.
- `ops-observability` (`02_Skills/Governance/Ops-Observability-v2.md`) OBSERVE mode — for tracking evidence-gate frequency and HALT patterns across runs.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting skills that produce plans with chronically missing evidence (systemic gap detection).

---

**Design note:** This v2.0 is the first full-source version of the evidence gathering protocol. It preserves the v1.1 multi-index structure (files, schemas, execution surfaces, consumers, MCP resources) and adds OLS-MCC v4.2 compliance: Boundaries, Failure Behavior (5 scenarios), Strategic Next Move, evidence-gate tracking for systemic analysis, and handoff to the full meta-tool ecosystem.
