# Babel Reliability 2026-11 — Six-Audit Engineering Program

> **Public source snapshot:** main `4133e32128c2a2e497319020b326fd36e315a744`, reconciled on 2026-11-21. **Original audit baseline:** `198193b1545682da66eae50f34f72aae4155aa8f`. **Campaign issue:** [#521](https://github.com/gthgomez/Babel/issues/521).

## Decision

Babel can execute real read/edit/test sequences in scoped scripted trials, but its admission, receipt relevance, final-revision verification and terminal representations can disagree. The six audits separately demonstrated **false success** (wrong work certified or stale verifier), **false non-certification** (correct work left `UNVERIFIED_PATCH`) and **status drift** across surfaces. Keep verified safeguards (kernel, scoped mutations, revision-aware receipts, fail-closed policy) and make them agree on the same task/candidate/evidence. Do not replace the engines or weaken evidence checks as a shortcut.

## Durable source-of-truth hierarchy

1. **[FINDINGS_INDEX.csv](FINDINGS_INDEX.csv)** — 100 tracking items with stable IDs, audit references, severity, one owner issue and current public evidence. The 22 P1 / 67 P2 / 11 P3 counts describe the audit register.
2. **[ROADMAP.md](ROADMAP.md)** — wave sequencing, exact handoffs, dependency graph and non-overlapping workstream ownership.
3. **[AGENT_WAVE.md](AGENT_WAVE.md)** — reusable cloud-coding-agent mission and PR/verification handoff. Root `AGENTS.md` alone governs contributor policy; this is task scope, not a competing instruction source.
4. **[QUALIFICATION.md](QUALIFICATION.md)** — independent positive/negative controls and release criteria.
5. **[GitHub #521](https://github.com/gthgomez/Babel/issues/521)** — live program index, issue/PR links and blocker status. Issue comments/PRs are implementation history; code + exact artifact tests are final delivery evidence.

The original audit reports and supporting evidence remain private. The public index keeps the audit-time status and adds a separate source disposition. `merged` records a landed repair for the described scope, `reviewed` records a reviewed candidate awaiting delivery, `historical` records an observation tied to an earlier release or source, `unverified` records a remaining evidence gap, and `non_blocking` records a bounded limitation or maintenance item outside the current offline qualification gate. Artifact qualification and closure require their own receipts.

Duplicate aliases stay with the primary row and owner. TF-26 maps to TF-17, RT-07 to RT-02, PV-09 to UX-08, UX-05 to SC-01, SC-16 to SC-07, and CI-16 to CI-02.

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

## PR reconciliation at the public source snapshot

- **Landed source PRs by workstream:** W01 [#545](https://github.com/gthgomez/Babel/pull/545), W02 [#544](https://github.com/gthgomez/Babel/pull/544), W03 [#550](https://github.com/gthgomez/Babel/pull/550), W04 [#546](https://github.com/gthgomez/Babel/pull/546), W05 [#540](https://github.com/gthgomez/Babel/pull/540), W06 [#548](https://github.com/gthgomez/Babel/pull/548), W07 [#549](https://github.com/gthgomez/Babel/pull/549), W09 [#541](https://github.com/gthgomez/Babel/pull/541), W10 [#547](https://github.com/gthgomez/Babel/pull/547), W11 [#539](https://github.com/gthgomez/Babel/pull/539), W12 [#543](https://github.com/gthgomez/Babel/pull/543), W13 [#538](https://github.com/gthgomez/Babel/pull/538), and W14 [#537](https://github.com/gthgomez/Babel/pull/537).
- **Merged follow-ups:** Windows repair fixture [#515](https://github.com/gthgomez/Babel/pull/515), offline CI summaries [#518](https://github.com/gthgomez/Babel/pull/518), Desktop second-turn repair [#520](https://github.com/gthgomez/Babel/pull/520), held-out grading [#551](https://github.com/gthgomez/Babel/pull/551), and durable turn recovery [#555](https://github.com/gthgomez/Babel/pull/555).
- **Open stabilization and release candidates:** W08 umbrella [#542](https://github.com/gthgomez/Babel/pull/542), Desktop staging [#554](https://github.com/gthgomez/Babel/pull/554), adoption [#556](https://github.com/gthgomez/Babel/pull/556), provider completion [#557](https://github.com/gthgomez/Babel/pull/557), boundary disclosure [#558](https://github.com/gthgomez/Babel/pull/558), and Windows settlement [#559](https://github.com/gthgomez/Babel/pull/559).
- **Older open drafts:** [#516](https://github.com/gthgomez/Babel/pull/516) remains held, [#517](https://github.com/gthgomez/Babel/pull/517) needs native balance evidence for its refreshed Windows timings, [#519](https://github.com/gthgomez/Babel/pull/519) needs authorized comparison with the incumbent reader, and [#536](https://github.com/gthgomez/Babel/pull/536) carries this public index.

Refresh exact heads and gate results before using the snapshot as acceptance evidence.

## Definition of a completed campaign

A changed line or green CI job does not satisfy a finding. For release-blocking concerns, require current-head independent reproduction or reasoned disproof; negative and positive fixture controls; a reviewed, merged, testable repair; source/packaged artifact provenance; installed journey where claimed; and *consistent terminal/evidence identity*. Completion and closure status must be updated in this register and #521. **No automatic deployment, publication, provider spending or merges follow from accepting this plan.**
