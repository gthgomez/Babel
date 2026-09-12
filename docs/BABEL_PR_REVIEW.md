<!--
status: ACTIVE
last_verified: 2026-09-12
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

The review/repair adapter explicitly requests `thinking: {type: "disabled"}`
for all three canonical models, without changing ordinary transport defaults.
[MiMo's protocol](https://mimo.mi.com/docs/en-US/api/chat/openai-api) documents
reasoning-content replay; [DeepSeek's thinking/tool protocol](https://api-docs.deepseek.com/guides/thinking_mode/)
requires it. Babel's current message schema cannot represent that history.
[LongCat documents the same toggle and thinking-on default](https://longcat.ai/platform/docs/open-code);
its separate compatibility reason is observed reasoning-only output-budget
exhaustion, not an established mandatory replay requirement. Invocation metadata
records the requested setting and model-specific reason, **not proof that the
OpenCode Go upstream applied it**. Qualification must exercise actual chat tool
round trips and final JSON before using a profile for PR evidence. Preserve a
separate reasoning-enabled research lane: implement full history/replay protocol,
then compare labeled review quality and efficiency against this compatibility
profile before promoting it. Non-thinking completion alone does not establish
review quality or approval.

Review and repair parsers accept plain JSON or one whole-document, newline-delimited
Markdown fence with only an empty or `json` language tag. They remove only that
wrapper before strict JSON/schema validation; prose, extra fences, unknown tags
and truncated JSON remain invalid. Raw answers are retained unchanged, as are
findings, blockers and exact replacement strings. This formatting normalization
does not relax provider completion, exact scope or independent-review checks.

Verdict paths use exact repository-relative scope. A single `source/` snapshot
mount prefix may be removed only when the result exactly matches that scope;
real repository paths beginning with `source/` take precedence. Unknown, missing,
absolute and traversal paths still fail validation. Findings and blockers are
not rewritten by this path conversion.

Reviews bind repository, PR, exact base/head, task hash, changed-file scope and
diff digest. A changed base or head invalidates the old approval. All required
CI checks, review-thread resolution and the immutable-base merge gate must pass.
The host workflow owns routine repairs and eligible merges within task authority;
review rejection or another SHA does not require repeated owner approval.

## Trusted host installation

Run the controller from a clean, independently verified, pinned installation,
not from the PR checkout. Its code supplies trusted instructions and execution
policy; its source commit must belong to the immutable PR base's merged history.
Candidate Git blobs are copied to a separate inert snapshot: no candidate
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

The review adapter buffers native response events until the provider validates
completion and model identity. It allows one retry for an eligible transient
transport failure, including a stream closed before its terminal marker, before
any buffered output is delivered to chat. Failed partial responses are discarded
from delivery, never executed or treated as completed evidence. Both attempts
remain recorded; unknown usage is not discarded. Identity, authentication and
cancellation failures are not retried.

Native responses also require a natural-completion or tool-call finish reason
and visible text or actual tool calls. Budget exhaustion, filtering, unknown
termination and reasoning-only/empty final output fail before any buffered
content reaches chat, including valid-looking but truncated JSON. Failed
inferences cannot trigger a syntax-only restatement request. Metadata retains
the provider's original finish reason and unknown usage; no synthetic `OK` is
accepted as review evidence.

The configured reviewer output budget is 32k completions
(`BABEL_REVIEW_OUTPUT_TOKENS`), shared by the request body and the advertised
model policy so the two cannot drift. Native-response buffers are sized above
that budget, so the configured output budget — not an event or byte buffer
guard — is the only truncation limit on a legitimate long answer.

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

Metrics separate pending (`started`, `running`, `cli_completed`), failed and
unknown-status artifacts. Pending does not prove that a process is still alive.
Observed token sums and metadata cost estimates exclude missing values; a total
estimated cost is `null` when any call lacks cost data. Estimates are not bills.
Generic CLI `usage.totalCostUSD` and `tool_call_count` are not substitutes for
complete provider metadata or retained `thread_events`; tool-outcome coverage
remains explicitly unknown until those events are loaded.

Record finding outcomes separately, without altering an approval or merge gate:

```powershell
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-adjudicate.mts --state-dir <private-non-git-directory> --record <private-adjudication-input-json>
```

The input is a strict JSON object with `execution_id`, an exact `candidate`
(`repository`, `pr_number`, `base_sha`, `head_sha`), `subject` (`kind`: `finding`
or `missed_defect`, and a stable SHA-256 `id`), `outcome` (`confirmed`,
`false_positive`, `missed_defect` or `inconclusive`), and nonempty `evidence`
references. Each reference has a `kind` (`test`, `reproduction`, `diff`, `review`,
`merge` or `artifact`) and `ref`: a credential-free GitHub HTTPS URL without a
query string, `artifact:relative/path`, or `sha256:<digest>`. Do not embed raw
logs, credentials or transcripts. The command secret-scans the record before
atomically appending a new UUID file under private `adjudications/` state.

Optional `links` connect `repair_execution_id`, `repair_head_sha`, `test_runs`
(reference strings), `rereview_execution_ids`, `merge_commit_sha` and `merge_ref`.
They are operator-recorded claims; the recorder does not fetch or validate
external test results, reviewer independence or merge state. Corrections append
another record for the same execution, candidate and subject; summaries use the
latest timestamp, breaking ties by record ID, while retaining earlier records.

Reported finding precision is only `confirmed / (confirmed + false_positive)`
over those labeled subjects. Inconclusive and missed-defect labels are excluded
from that denominator. Unlabeled executions, missing execution links and invalid
records are reported separately. Recall, total defect coverage and time to a
verified merge remain unknown; approval counts are never accuracy scores.

A harness failure is useful data, but not a passed review. Reproduce it with a
small regression test, fix the trusted harness in its own candidate, independently
review that change, promote its verified installation, and rerun affected PRs.
