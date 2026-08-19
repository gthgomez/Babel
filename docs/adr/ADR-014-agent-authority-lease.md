# ADR-014: Agent Authority Lease (cross-harness autonomy V2)

**Status:** Accepted · **Date:** 2026-08-15 · **Applies to:** babel-cli runtime + harness adapters (Claude Code, Codex, Cursor, Antigravity/Gemini)

## Problem

Repeated approvals reduce coding-agent productivity, while blanket permissions create unacceptable risk (a coding agent with a `repo`-scope PAT can self-merge, force-push, or read secrets). Prior work (ADR-012, autonomy contract V1) established Class A–D taxonomy and native deny layers, but V1 left: no session/task authority envelope, no structured git/GitHub capabilities, raw-shell-only classification, no bounded CI repair, no policy-integrity protection, and a Babel enforcement seam (C/D presets documented but not wired to dispatch).

## Decision

Introduce an **AutonomyLease** — the authority envelope for the current session/task — decided by a small deterministic **Policy Decision Point (PDP)** and enforced at the existing dispatch gate (`toolExecutor.executeActionWithPolicy`, the central policy gate for tool calls).

```
ActionRequest { capability, repository, remote, source/dest branch, force, delete }
      → PDP (pure, typed, tested) × AutonomyLease
      → { ALLOW | VERIFY | ASK | DENY, reasonCode, rulesTriggered[] }
      → Harness PEPs: Babel dispatch / Claude deny+hooks / Codex rules / Cursor cli.json / Antigravity permissions
```

Key properties:

1. **Capability-based, not string-based.** `git push origin feat/x` parses to `{capability: push_feature_branch, remote: origin, destinationBranch: feat/x, force: false}` — the PDP decides on structure. Raw-shell regexes remain defense in depth, never the root authority (R8).
2. **Fail-closed.** Unknown capability, unknown tool, lease mismatch, force push, remote-ref delete → DENY with stable reason codes (`DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT`, `DENY_LEASE_MISMATCH`, `DENY_FORCE_PUSH_POLICY`, …). Gated capabilities (merge, release, deploy, admin, security change) → ASK. Publication (push feature branch, draft PR, CI inspect/repair) → VERIFY — dispatch allows, completion gate enforces.
3. **Four separate axes** (complexity / consequence / authority / verification) — never collapsed into one enum.
4. **Policy integrity.** Governance paths (`babel-cli/src/authority/**`, `.claude/settings.json`, hooks, rules, workflows, AGENTS/CLAUDE/GEMINI) are write-denied for the agent (`DENY_POLICY_SELF_MUTATION`); baseline hashes detect drift. `expose_credentials` is ALWAYS denied regardless of lease content.
5. **Bounded CI repair.** Pure state machine (`ciRepair.ts`): 3 product rounds + 1 transient rerun (lease-budgeted); product rounds require a real code change + local verification; SECURITY_GATE failures block, never "fixed" by weakening controls.
6. **Additive.** No lease env → byte-identical legacy behavior; V9 lane and agentContracts untouched (zero co-evolution debt).

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Behavioral rules only (V1) | Rejected — unenforceable; R8 demonstrated six+ string-variance bypasses |
| Static allow/deny only | Rejected — cannot express branch/remote/force preconditions |
| Dynamic hooks only | Rejected as sole control — hook failures fail open; deny rules stay authoritative |
| Imported policy engines (OPA/Rego, Cedar-wasm, Casbin, OpenFGA) | Rejected (R6) — toolchain weight for ~10–25 rules; node-casbin stalled; OpenFGA is a stateful server. Escape hatch: Cedar-wasm if rules outgrow ~20 patterns |
| Full sandbox auto-approval / bypass modes | Rejected — R2/R4: YOLO modes unbounded; native sandbox absent on Windows |
| Intent-based authorization (LLM judge) | Rejected (R6) — non-deterministic, forgeable by prompt injection |

## Security model

- **Trust assumptions:** the lease is issued out-of-band (env / user-owned file), never by the agent; harness deny layers (Claude `permissions.deny`, Codex `forbidden`, Cursor `cli.json` deny) are the hard complement to the PDP; the GitHub ruleset (`protect-main`: PR + 5 checks, force-push blocked, zero bypass actors) is the server-side backstop.
- **Enforcement boundaries:** PDP consults in `executeActionWithPolicy` (every side-effecting tool call); structured git/gh parsing is best-effort argv (aliases/`git -c`/env expansion are documented residual risks, covered by harness deny layers).
- **Escape risks (R8):** argv obfuscation, `gh api` endpoint classes (refs/releases/workflows/gists → gated), renamed/symlinked credential files, subprocess reads (no OS sandbox on Windows), policy self-edit (denied), false verification (completion gate + verifier receipts pre-date this ADR and remain authoritative).
- **Failure behavior:** broken lease env → loud throw at first decision; unknown capability → DENY; hook failure → fail open by design, compensated by deny rules; CI budgets exhausted → escalate with evidence.

## Consequences

- **Complexity:** +8 small modules (~1.2k lines incl. tests), one integration point in `toolExecutor.ts`.
- **Maintenance:** capability registry + reason codes are versioned; new capabilities are additive.
- **Portability:** the lease schema is vendor-neutral; harness adapters consume the same contract natively (Claude ask/deny rules, Codex execpolicy, Cursor cli.json, Antigravity permissions file).
- **User experience:** routine SWE and bounded publication (branch push, draft PR, CI repair) become prompt-free within the lease; merge/release/deploy/admin remain human gates.
- **Residual risk:** identity is still a classic `repo`-scope PAT (see V2 report §GitHub recommendation — needs user authorization to move to a GitHub App); Windows lacks an OS sandbox; unknown-tool classification is local-by-default with a known-dangerous-tool denylist.
