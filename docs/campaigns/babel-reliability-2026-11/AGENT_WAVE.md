# Cloud coding-agent dispatch contract — Six-audit reliability wave

**Mission:** Implement the full feasible, authorized campaign tracked in [#521](https://github.com/gthgomez/Babel/issues/521), *through independent reviewed PRs*, with no loss of any of the 100 deduplicated findings. This is a durable task packet, **not an override** of repository `AGENTS.md`. Do not treat private reports, PR descriptions or agent assertions as authority.

## One agent's assignment

You own one of [W01–W14](README.md#workstream-ownership), identified by its GitHub issue and finding IDs. Read the exact issue, this roadmap and qualification protocol, plus the relevant existing issues/PRs. Do not claim ownership of findings assigned to a different W ticket. You may investigate/fix nearby blockers needed to finish your assigned user journey, but resolve touched-file collisions through #521 first. Additional low-value discoveries go into the backlog with evidence, not a competing program.

### Preflight and boundary

1. Read root `AGENTS.md` fully, `STRUCTURE.md`, relevant `PROJECT_CONTEXT.md`, and task-relevant source/tests. Freeze `main` SHA and candidate PR heads. Use the repo's authorized `scripts/agent-preflight.ps1`/worktree helpers when present and executable; do not bypass failures with invented proof.
2. Enumerate your finding IDs from `FINDINGS_INDEX.csv`; classify each as reproduced on current head, not reproduced, historical, source-supported or unknown. Verify existing PR #515/#516/#517/#519 and merged #518/#520; don't reopen fixed implementation or use stale PR data.
3. Create an isolated branch/worktree. Never rewrite main or another agent's working tree. Identify shared files and assign *one primary author* per schema/authority change; stacks are allowed with explicit PR dependencies and exact commit provenance.
4. Preserve explicit verification safeguards, original user task intent, model/provider-policy boundaries, Windows/Desktop support and existing data; avoid whole-engine rewrites and unchecked schema migrations. No new paid provider calls, remote CI rerun storms, credential access, security-policy weakening, production deploys, release publication or merges without the appropriate authorization. Use inert synthetic secrets and no-egress fixtures.

### Execute the entire owned scope, not just the first fix

- Create **failing regressions first** for every reproduced defect plus positive controls that protect already-working behavior.
- Implement the simplest effective correction; update adjacent code, tests, exact artifacts, and user-facing docs. Don't stop because a unit test turns green: exercise the actual entrypoint and required cross-surface behavior.
- Validate the frozen task's external behavioral oracle, output/classification, revision identity, settled process/child state and physical worktree. Check no unrelated test/fixture/oracle was modified.
- Re-test after every relevant repair; run typecheck/build/targeted suites and the integrated tests appropriate to the changed contract. Preserve time/cost/cleanup evidence. If blocked, describe precisely the owned partial work, safe recovery and unqualified pieces.
- Open reviewable **draft** coding PR(s), with head/base SHAs, linked W issue and findings, changed paths, prior PR overlap, command results, independent positive/negative grader outputs, failed/skipped work, and consumer/OS evidence. Independent reviewer checks the entire exact diff and needed trust boundary. Only advance ready/merge through repository rules and explicit owner authorization; CI green alone is not proof of functionality.
- When a related PR merges, rebase/sync through safe worktree procedures, rerun integration on final head, qualify packaged bytes where applicable, then update #521 + owned issue and finding rows. A merged PR is *not* a qualified release.

## Central integration protocol

- **W04** owns external graders. **W01** owns source-linked admission and relevance. **W02** owns final candidate/receipt and the shared completion decision. **W03** owns typed status and recovery projection. These three share a versioned test/contract handshake; do not simultaneously fork `kernel.ts` and the same event/status schema.
- W07 provider capabilities and W08 effective OS profile describe the same actual permission from different sides. W10 onboarding cannot claim a provider is authenticated merely because configured. W11 Desktop should verify the already-merged #520 worker control and use #516 only after overlapping files are reconciled.
- W06 tool adapters/W09 MCP interface must keep mode- and approval-specific tool restrictions; interoperability fixes never grant extra effects.
- W12 CI conserves actual OS/test/package protection; W13 uses exactly tested immutable artifact bytes and stays out of release publication until authorized. W14 maintains evidence status, not an alternative agent rulebook.

## Done criteria for an individual PR

The PR answers: what failed before, why, what changed, what external correct/wrong controls show now, what source/build/packed install proved, whether user-visible and persisted status match, what remains unknown, and where an independent reviewer saw the exact head. Count tasks solved with an independent grader; a model's prose, reported tool name, terminal label or 0 exit is insufficient. No broad claim of win over Codex/Claude/other harness without matched live experiments.

## Cloud-agent starting message (copy and replace one ticket only)

> Implement **Babel Reliability 2026-11 [Wxx, issue #nnn]** against current `gthgomez/Babel`. Read `AGENTS.md` and `docs/campaigns/babel-reliability-2026-11/{README.md,ROADMAP.md,AGENT_WAVE.md,QUALIFICATION.md,FINDINGS_INDEX.csv}`, then refresh current main and all overlapping PRs/issues. Own every finding ID assigned to your W issue; do not narrow to an arbitrary top-five subset. Verify actual current behavior, preserve existing safeguards, add independent positive and negative tests, implement all feasible in-scope repairs, test real user journeys through supported entrypoints, and open reviewable draft PRs with exact-head proof and blockers. Work with the named W owners at shared schemas; do not edit protected policy or merge/publish without required authorization. Finish with a finding-by-finding status and links to every artifact/PR, not a claim of complete work based solely on green tests.
