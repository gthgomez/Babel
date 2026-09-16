<!--
status: ACTIVE
last_verified: 2026-09-16
-->
# Chat truth repair — external review handoff

This note records the bounded implementation that followed the PR #187
re-audit package and identifies what remains undecided. It is intentionally
evidence-scoped: passing helper tests does not mean the full ChatEngine or
merge route is qualified.

## Revision and scope

The repaired branch is `codex/chat-truth-repair-20260915`. The repaired head is
`19c780274f631dbf7ae45e5cc4463cb4b0f1b584`; the pre-repair candidate was
`edd7ee43d728aa954a4d1d9e84cb098304fc5510`; observed `origin/main` was
`017ec8cc28dbfbabf8138794096b1af00212b474`.

The change set is 19 tracked files and remains below the repository's normal
review-size limit. Existing unrelated untracked worktrees and local artifacts
were deliberately excluded.

## Closure map

| Area | Current evidence | Remaining decision or work |
| --- | --- | --- |
| F01 effect truth | Failed direct mutations now retain failure status, avoid confirmed-write projections, invalidate reads conservatively, and use executor paths for successful patch projections. | Qualify failed no-effect, partial-effect, no-op, and real caller/UI/durable-event journeys end to end. |
| F02 instructions | UTF-16 budgeting is consistent, source and delivered-fragment digests are separated, and text-mode system context is retained once. | Text mode still omits some optional appended/preflight/repository/verifier context; decide which instructions are mandatory in every delivery mode and test the outbound request. |
| F03 freshness | Same-count compaction, branch resync, and conversation replacement now advance read-context identity. | Exercise restart/resume, concurrent roots, write-then-fail effects, and repeated compaction with real engine state. |
| F04 execution | Windows UNC parsing and empty-argument quoting have regression coverage. | The authorization parser and native child-process execution still need an explicit shared argv/shell specification and Windows process qualification. |
| F05 accounting | Exact request bytes are hashed and estimated, but the estimate is not the compaction/preflight decision input. | Build one prepared-request object, make one bounded compact/rebuild decision, and send the exact prepared bytes. This is the largest correctness gap still open. |
| F06 causal evidence | Empty, duplicate, conflicting, and contradictory attempts no longer become unqualified `ready`. | Bind projections to a verified durable event prefix/session identity; keep projection write failures diagnostic and non-blocking. |
| F07 manifests | Canonical digest, inventory shape, resolved containment, symlink escapes, and metadata-only drift are checked. | The feature remains an unsigned manifest of explicitly listed files, not repository-wide provenance. Add bound tracked/untracked/excluded inventory or keep the claim narrow. |
| P01 selection | `test:chat-truth` has an explicit 21-file list and is wired into Linux and Windows jobs. | CI must execute it on the published head; local Windows symlink creation is unavailable, so that case remains skipped here. |

## Budget opinion

`chatEngine.ts` is not at a healthy budget. The configured budget is 4,506
lines; the pre-repair candidate was already 6,647 lines and the repaired head
is 6,687. The ratchet failure is therefore pre-existing, although this repair
adds 40 lines to the file. Raising the budget just enough to hide that growth
would preserve the architectural problem.

My recommendation is a two-stage decision:

1. Treat the current budget failure as a known baseline blocker for this repair
   branch, not as evidence that the new behavior is incorrect.
2. Extract cohesive seams before the next substantial ChatEngine feature:
   mutation/effect projection, prompt preparation, compaction lifecycle, and
   durable evidence projection are the highest-value candidates. Keep the
   4,506-line limit as the long-term target; if one seam genuinely belongs in a
   larger coordinator, raise its budget deliberately with a documented
   rationale and a ratchet follow-up, not as a blanket exemption.

Other observed over-budget files are separate architectural debt: `coreCommands.ts`
is 6,264/4,709 lines, `waterfall.ts` is 2,345/2,165, and several files such as
`pipeline.ts` and `executorLoop.ts` are at their configured ceilings. They
should be handled in focused extraction work, not mixed into this truth-repair
review unless a changed contract requires it.

## Recommended external-review questions

1. Is F01's conservative treatment of possible partial effects sufficient, or
   should the executor expose a typed effect state (`confirmed`, `no_effect`,
   `indeterminate`) before more UI/recovery behavior is added?
2. Which instruction sections are mandatory for native, text, and legacy modes?
   The answer should be a contract with nonce-on-wire tests, not a prompt-size
   preference.
3. Should F05 be implemented before merge as a small provider-neutral prepared
   request, or split as the next dependent change? Avoid claiming accounting
   closure from the existing digest alone.
4. Is the unsigned, explicitly enumerated F07 manifest useful enough to retain,
   or should its exporter be opt-in and its public wording be narrowed further?
5. Should the ratchet be enforced through extraction now, or should this branch
   be reviewed as a correctness patch with a separately owned architecture
   debt issue?

## Verification record

Observed locally on the repaired head:

- `npm run test:chat-truth`: 210 passed, 1 platform-dependent symlink test
  skipped because the host denied symlink creation.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `tools/preflight-ratchet.ps1`: failed on the pre-existing over-budget files
  listed above.
- Public scrub/content-policy/strict secret scans: not established; the local
  scripts exceeded a bounded wait without producing a result and were stopped.

No live model calls, paid reviews, remote merge, or benchmark claims are part
of this revision.
