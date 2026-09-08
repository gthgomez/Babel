<!--
status: ACTIVE
last_verified: 2026-09-08
-->
# Babel chat PR review

The reviewer is Babel's actual chat engine, using OpenCode Go models on the
owner's host. GitHub stores controller-published evidence and runs deterministic
gates; it does not supply a paid AI reviewer. This path needs no separate GitHub
App or custom signing/custody service.

## Review and merge contract

Every PR needs at least one approving Babel chat review. GREEN and YELLOW need
one independent perspective; RED needs two distinct reviewer executions, at
least one using Babel chat. The host review queue currently runs MiMo v2.5 and
LongCat 2.0 in separate contexts. DeepSeek V4 Flash is also a canonical supported
OpenCode Go model. The model that actually answered is recorded; a configured
name or fallback assumption is not sufficient attribution.

Reviews bind repository, PR, exact base/head, task hash, changed-file scope and
diff digest. A changed base or head invalidates the old approval. All required
CI checks, review-thread resolution and the immutable-base merge gate must pass.
The host workflow owns routine repairs and eligible merges within task authority;
review rejection or another SHA does not require repeated owner approval.

## Trusted host installation

Run the controller from a clean, independently verified, pinned installation,
not from the PR checkout. Its code supplies trusted instructions and execution
policy. Candidate Git blobs are copied to a separate inert snapshot: no candidate
checkout hooks, dependency installation, or candidate code execution is needed
for review. Secret scanning precedes provider exposure.

Each reviewer is a fresh child process with source-reading capabilities only.
Writes, shell commands, subagents, shared-memory mutation, GitHub credentials,
and controller-state reads are unavailable to it. Provider credentials are
resolved through the approved helper without printing them. `readonly_sandbox`
in the receipt names this application/tool-enforced boundary, not an OS sandbox
or cryptographic proof of isolation.

The controller normalizes output and publishes through the existing owner
GitHub identity. The base-rooted evaluator re-fetches that live comment and
checks the owner numeric identity and complete body; a local evidence file is
not sufficient provenance. The optional v2 `harness` object has exactly:

```json
{
  "name": "babel",
  "mode": "chat",
  "version": "<64-lowercase-hex installation digest>",
  "source_sha": "<40-lowercase-hex trusted source commit>",
  "execution_id": "<same execution_id as the review>"
}
```

The current merge gate requires valid chat metadata. Low-level v2 validation
retains compatibility with earlier receipts for bootstrap/older-base evaluation.
A changed evaluator does not authorize itself: use the previously trusted base
and independent reviewers, then promote the new installation.

## Running and scheduling

From the trusted installation, with Node dependencies already installed:

```powershell
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-review.mts --repo-root <trusted-git-clone> --state-dir <private-non-git-directory> --pr <number>
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-review.mts --repo-root <trusted-git-clone> --state-dir <private-non-git-directory> --all --publish
```

The first command collects local dogfooding data without publication. The second
discovers open PRs and publishes normalized evidence. `--task <owner-task-file>`
supplies the current authorized objective; historical attachments are reference
data, not a superseding mission. Keep state outside every Git worktree and away
from candidate-readable paths. `--publish` refuses dirty trusted installations.

The command is a queue sweep, not a background daemon. A separately configured
host scheduler must invoke it repeatedly for continuous coverage. Scheduling is
active only after that host installation and recurring job are verified; a
checked-in script alone does not establish that every PR is being watched.

## Repair without self-approval

The read-only reviewer reports findings; it cannot apply fixes. The orchestrating
agent may assign a separate Babel chat implementation session an isolated task
worktree and the scoped findings. That repair session has the granted engineering
capabilities, but no review or merge approval authority. This is a separate
workflow step, not an implicit write capability in the reviewer command.

The optional proposal command uses a separate DeepSeek V4 Flash Babel chat
context. Its `--apply` option applies exact scoped replacements to a new local
worktree; it does not run candidate code, commit, push, or approve anything:

```powershell
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-repair.mts --repo-root <trusted-git-clone> --state-dir <private-non-git-directory> --handoff <private-handoff-json> --apply
```

After a proposed repair, inspect its diff, run relevant deterministic tests and
security checks, commit/push the exact candidate, and rerun independent review in
fresh contexts. A reviewer approval without executed tests does not establish
test success. Rejected or uncertain findings go through evidence-based
adjudication; do not mechanically rewrite BLOCK to APPROVE or weaken a gate.
Merge only the exact candidate accepted by CI and the base-rooted gate.

## Harness learning and operating limits

Owner-authorized Babel PR review has no dollar cap. Retain wall-clock, turn,
stall, concurrency and bounded retry controls to prevent runaway or duplicate
work. Measure tokens, latency and provider-reported usage; distinguish estimates
from billed cost and preserve unknown values rather than reporting zero.

Keep per-run artifacts, tool outcomes, completion classification, requested and
observed models, installation identity, malformed output and failed attempts in
private host state. Publish only secret-scanned normalized findings/provenance.
Track invalid verdicts, denied-tool loops, source-context truncation, false
environment blockers, missed defects, finding precision, repair regressions and
time to a verified merge. Confirm findings with reproducible counterexamples or
tests; retain adjudications to distinguish useful discoveries from false alarms.

Aggregate retained observations without publishing raw transcripts:

```powershell
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-metrics.mts --state-dir <private-non-git-directory>
```

A harness failure is useful data, but not a passed review. Reproduce it with a
small regression test, fix the trusted harness in its own candidate, independently
review that change, promote its verified installation, and rerun affected PRs.
