<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Compliance Evidence Audit (v1.1)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_compliance_gpc`, `domain_swe_backend`, `domain_research`
**Activation:** Load for any task involving audit logs, decision records, proof claims, retention, exportability, or regulator-facing evidence quality.

## Purpose

Many products claim "audit-ready" long before their evidence model deserves it.

This skill checks whether evidence claims are backed by:
- real stored fields
- real failure-path recording
- real access controls
- real retention behavior
- real export surfaces
- real tamper story
- real operator workflow when human handling is part of the promise

## Audit Axes

For each evidence claim, verify all applicable axes:

| Axis | Ask |
|------|-----|
| Capture | Is the claimed field actually persisted? |
| Scope | Does it cover success only, or denied / failed / edge cases too? |
| Integrity | Can records be altered, overwritten, or silently deleted? |
| Access | Can the correct tenant retrieve them safely? |
| Retention | Is retention enforced in code / jobs, or only promised in copy? |
| Export | Can customers actually export the evidence claimed? |
| Operations | If a human workflow is implied, is there a real status, queue, or runbook? |
| Traceability | Can the operator prove which run, job, or event produced the current alert or record? |
| Authorization | Can the correct tenant actually read the claimed evidence under live RLS and grants, including active partitions? |

## Minimum Evidence Verdict

A product should not be described as "audit-ready evidence" unless all of the following are true:
- fields needed for the claim are stored
- retrieval path exists
- tenant scoping exists
- failure-path logging exists for the relevant promise
- retention and export claims are implemented, not aspirational

If one or more are missing, downgrade:
- `usable logs`
- `tenant-scoped records`
- `partial evidence`
- `operator-assisted process`

Do not jump to `audit-ready`.

## Immutability Check

The word `immutable` is high-risk. Require one of:
- append-only controls
- tamper-evident chain
- WORM / retention lock
- explicit immutable storage contract

A normal table with inserts is not enough.

## Failure-Path Check

If the product claims proof of enforcement, verify whether it records:
- allow path
- deny path
- configuration rejects
- infra failure
- circuit-open / paused state

Success-only logs do not prove full enforcement behavior.

## Operations Check

If the product claims managed privacy requests, incident-ready support, continuous monitoring, or
operational retention, verify whether there is:
- a visible run history or status surface
- an alert or escalation path
- a named operator workflow or runbook
- a way to detect stuck items
- a traceable link between active incidents and the concrete run or event that triggered them
- a defined acknowledge / resolve lifecycle if operators are expected to close incidents

If not, downgrade the claim to intake, passive visibility, or partial operations only.

## Live Access Check

For any claim that depends on tenant retrieval, verify both:
- the intended policy/grant state in migrations or schema snapshots
- the effective live state in the target environment

Partitioned tables require explicit verification of the active child partitions, not just the parent.

If code says a tenant can read evidence but the live project denies access, classify that as
`authorization drift`, not as a code-complete success.

## Safe Claim Language

Prefer the smallest true phrase:
- `request intake` instead of `fully managed privacy workflow`
- `tenant-scoped evidence views` instead of `regulator-ready evidence`
- `automated retention function` instead of `operational retention program`
- `dashboard-only usage warning` instead of `alerting`

## Hard Rules

1. Do not infer evidence richness from marketing JSON.
2. Retention text without automation is not enforced retention.
3. Export promises require a route, job, or documented product path.
4. Schema fields beat UI labels.
5. A record can be useful without being regulator-ready; say that clearly.
6. A status field alone is not an operational workflow.
7. “Immutable” and “continuous monitoring” require stronger proof than normal table writes and a dashboard view.
8. A deduplicated alert row without run linkage is weaker evidence than it first appears.
9. An escalation from warning to critical that produces no new visible signal is not operationally complete monitoring.
10. Parent-table grants are not enough evidence for partitioned-table retrieval claims.
