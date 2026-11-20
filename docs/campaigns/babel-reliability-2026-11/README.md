# Babel Reliability 2026-11 — Six-Audit Engineering Program

> **Status:** proposed implementation program, not a certified release or a statement that all findings remain open. **Source baseline:** public main `198193b1545682da66eae50f34f72aae4155aa8f`, independently reconciled on 2026-11-18. **Campaign issue:** [#521](https://github.com/gthgomez/Babel/issues/521). **Planning branch:** `docs/six-audit-parallel-wave-20261118`.

## Decision

Babel can execute real read/edit/test sequences in scoped scripted trials, but its admission, receipt relevance, final-revision verification and terminal representations can disagree. The six audits separately demonstrated **false success** (wrong work certified or stale verifier), **false non-certification** (correct work left `UNVERIFIED_PATCH`) and **status drift** across surfaces. Keep verified safeguards (kernel, scoped mutations, revision-aware receipts, fail-closed policy) and make them agree on the same task/candidate/evidence. Do not replace the engines or weaken evidence checks as a shortcut.

## Durable source-of-truth hierarchy

1. **[FINDINGS_INDEX.csv](FINDINGS_INDEX.csv)** — 100 distinct tracking items, stable IDs, source audit references, severity, owner issue and snapshot status. 22 P1 / 67 P2 / 11 P3; this is *not* a count of current confirmed production defects.
2. **[ROADMAP.md](ROADMAP.md)** — wave sequencing, exact handoffs, dependency graph and non-overlapping workstream ownership.
3. **[AGENT_WAVE.md](AGENT_WAVE.md)** — reusable cloud-coding-agent mission and PR/verification handoff. Root `AGENTS.md` alone governs contributor policy; this is task scope, not a competing instruction source.
4. **[QUALIFICATION.md](QUALIFICATION.md)** — independent positive/negative controls and release criteria.
5. **[GitHub #521](https://github.com/gthgomez/Babel/issues/521)** — live program index, issue/PR links and blocker status. Issue comments/PRs are implementation history; code + exact artifact tests are final delivery evidence.

The original six independent reports, full causal/security notes and supporting archives belong in the **private audit evidence** record; this public register uses non-exploitative summaries. The sixth report remains in open private PR #164 and must not silently become the sole canonical truth. The first five reports were user-supplied on 2026-11-18. The PDF/ZIP evidence archives are not reproduced in this public repository.

## Workstream ownership

| Wave ticket | Scope | Finding count |
|---|---|---:|
| [W01 #522](https://github.com/gthgomez/Babel/issues/522) | Source-linked task admission and relevant witnesses | 8 |
| [W02 #523](https://github.com/gthgomez/Babel/issues/523) | Final tree, Chat/Deep completion authority | 7 |
| [W03 #524](https://github.com/gthgomez/Babel/issues/524) | Status, recovery, terminal/diff projection | 10 |
| [W04 #525](https://github.com/gthgomez/Babel/issues/525) | Independent benchmarks and evaluation semantics | 5 |
| [W05 #526](https://github.com/gthgomez/Babel/issues/526) | Context, instruction retention and child adoption | 4 |
| [W06 #527](https://github.com/gthgomez/Babel/issues/527) | Tool schemas and governed command execution | 8 |
| [W07 #528](https://github.com/gthgomez/Babel/issues/528) | Providers, offline routing, optional budgets | 8 |
| [W08 #529](https://github.com/gthgomez/Babel/issues/529) | Effective sandbox/credential/process boundaries | 7 |
| [W09 #530](https://github.com/gthgomez/Babel/issues/530) | MCP interoperability and diagnostic trust | 5 |
| [W10 #531](https://github.com/gthgomez/Babel/issues/531) | First-run CLI/TUI, narrow PTY and remote UI | 10 |
| [W11 #532](https://github.com/gthgomez/Babel/issues/532) | Desktop/Deep installed integration | 6 |
| [W12 #533](https://github.com/gthgomez/Babel/issues/533) | CI timing, identities and cost | 7 |
| [W13 #534](https://github.com/gthgomez/Babel/issues/534) | Release artifact and supply-chain qualification | 10 |
| [W14 #535](https://github.com/gthgomez/Babel/issues/535) | Architecture ownership and audit stewardship | 5 |
| **Total** | **Every distinct finding assigned once** | **100** |

## PR reconciliation at campaign creation

- **Already merged:** [#520](https://github.com/gthgomez/Babel/pull/520) Desktop second-turn race candidate; [#518](https://github.com/gthgomez/Babel/pull/518) CI report. These are *not* new implementation tasks. Verify integrated source and installed products before closing their findings.
- **Open draft at planning time:** [#515](https://github.com/gthgomez/Babel/pull/515) Windows QA, [#516](https://github.com/gthgomez/Babel/pull/516) first-use/provider, [#517](https://github.com/gthgomez/Babel/pull/517) Windows shards, [#519](https://github.com/gthgomez/Babel/pull/519) workflow-attempt evidence. Recheck status before acting.
- **Existing issue inheritance:** #217 reliability hub, #259 acceptance, #280 freshness, #293 settlement, #272 recovery, #273 tool catalogs, #274 provider models, #279 comparison and related issues linked in workstream tickets.

## Definition of a completed campaign

A changed line or green CI job does not satisfy a finding. For release-blocking concerns, require current-head independent reproduction or reasoned disproof; negative and positive fixture controls; a reviewed, merged, testable repair; source/packaged artifact provenance; installed journey where claimed; and *consistent terminal/evidence identity*. Completion and closure status must be updated in this register and #521. **No automatic deployment, publication, provider spending or merges follow from accepting this plan.**
