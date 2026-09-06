<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-06
-->

# Babel Frontier Milestone Review V1

Process for independent frontier-model review of major milestones (Tier 3 in
the risk-tier model of [AUTONOMY_POLICY.md](../AUTONOMY_POLICY.md)) and for
adversarial audits of trust/security-relevant work (Tier 4). Non-normative
by design: this document defines the packet and the instruction pattern; it
does not grant any agent authority to invoke an external frontier service,
and it assumes nothing about which model backends are configured.

## Why a packet, not a report

The frontier reviewer must receive enough raw, source-of-truth evidence to
re-establish important facts independently. A long builder narrative
priming the reviewer with "everything passes" is exactly the correlated-
failure mode the review model warns about (see
[AUTONOMY_THREAT_MODEL_V1.md](./AUTONOMY_THREAT_MODEL_V1.md), principle 3).
The packet is evidence-first; the builder's conclusions appear last, clearly
labeled, and the auditor is instructed to distrust them.

## Milestone definition

A milestone is a campaign-tracked outcome that groups multiple merged PRs
and work items toward one declared objective — for example a subsystem
completion, a feature campaign, or a release candidate. Milestones are
recorded in the canonical campaign records under `docs/campaigns/` (phase
tracker + verification log), which is where the packet's claims must come
from.

## Review packet contents

Generated from source-of-truth artifacts, in this order:

1. **Objective** — the milestone's stated goal and success criteria as
   declared *before* implementation (acceptance criteria, not post-hoc).
2. **Risk classification** — tier (0–5) and why.
3. **Coordinates** — base SHA, final head SHA (post-final-merge `main`),
   merge range, changed-path summary, protected-surface summary (any
   overlap with trust-root paths).
4. **Evidence links** — the PR list with per-PR review tier, required-check
   results at merge, and links to the exact workflow runs.
5. **Tests and evals** — suites run, results, known negative tests, eval
   matrix rows touched (link to
   [AUTONOMY_EVAL_MATRIX_V1.md](./AUTONOMY_EVAL_MATRIX_V1.md)).
6. **Runtime/behavioral evidence** — E2E runs, smoke outputs, measured
   behavior; distinguish observed evidence from configuration.
7. **Independent findings ledger** — every reviewer finding (blocking and
   non-blocking), which were fixed and how, which were declined and why.
8. **Known deferred issues and residual risks** — from the campaign record's
   risk sections; stale or missing entries here are audit findings.
9. **Open questions** — decisions taken under uncertainty, with the
   evidence that supported them.
10. **The exact diff or per-PR diff links** — the auditor must be able to
    read the code without trusting anyone's summary.

## Routing: Sol vs Astra

- **Sol-class review** (strong engineering reviewer): substantial PRs,
  architecture-affecting changes, difficult debugging, Tier 2–3 review.
  Used more frequently.
- **Astra-class audit** (strongest frontier governor): major milestone
  go/no-go, trust/security audits, cross-project reasoning, unresolved
  hard failures, adversarial falsification. Used sparingly — the owner
  attention budget assumes roughly one Astra-class engagement per
  milestone, not per PR.

Neither model is a routine coding worker; implementation stays with the
fast worker tier.

## The audit instruction

The standard instruction accompanying the packet:

```text
Attempt to falsify the claim that this milestone is ready.

Do not trust the implementer's conclusions, reviewer verdicts, summaries,
or stated test coverage merely because they exist. Re-establish important
facts from the source-of-truth artifacts in this packet. Look specifically
for: requirement drift; self-consistent but wrong tests; untested negative
paths; security regressions; hidden scope expansion; integration failures;
stale evidence; merge-base drift; correlated reviewer assumptions; unsafe
autonomy; missing operational concerns.

Return blocking findings separately from backlog observations.
```

## Consuming the findings

- **Blocking findings** route back into the normal loop: implementer fixes,
  verification reruns, targeted re-review — the owner does not relay
  messages between agents.
- **Backlog observations** land in the campaign record's risk/backlog
  sections with triage; they are not Milestone-blocking.
- The milestone is closed only when the blocking-findings list is empty and
  the closure is recorded (with the audit packet reference) in the campaign
  record. This mirrors the merge gate's `blocking_findings=[]` semantics.

## Owner interaction shape

The intended total owner involvement for a milestone is one consolidated
prompt — for example: run an adversarial frontier audit of milestone X with
the generated packet — plus any genuinely `OWNER_REQUIRED` acts the audit
surfaces. Everything else (packet generation, evidence collection, finding
repair, re-verification) is agent work.
