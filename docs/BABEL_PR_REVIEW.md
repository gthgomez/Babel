<!--
status: ACTIVE
last_verified: 2026-09-13
-->
# Babel PR Review & Independent-Agent Review Authority

PR review authority in Babel is controller-verifiable and rooted in execution independence.
GitHub stores controller-published evidence and runs deterministic gates; it does not supply
a paid AI reviewer. This path needs no separate GitHub App or custom signing/custody service.

## V3 Independent-Agent Review Authority (Canonical)

Under V3 (`independent_agent_review_v3`, `host_review_handoff_v3`), review authority derives
from a trusted controller launching a fresh, independent reviewer context bound to the exact
candidate SHA and digest. Authority is **not** restricted to Babel chat, OpenCode Go, or any
specific vendor or model family.

### Core Principles
1. **Execution Independence**: The reviewer must be a separately launched execution controlled
   by the trusted controller and bound to the exact candidate. It is valid for:
   - Codex Agent A (implementation) → Codex Agent B (independent review), provided A and B
     are separately created agent contexts/executions.
   - Any supported runtime/agent engine (Codex, Claude, Babel, OpenCode, etc.) to review.
2. **Three-Level Actor Identity**:
   - `kind`: Agent family/engine (e.g., `codex`, `claude_code`, `babel_chat`, `opencode_interpreter`).
   - `principal_id`: Logical agent identity or persistent persona. Must differ from builder (`principal_id != builder.principal_id`).
   - `execution_id`: Specific execution/run identifier. Must differ from builder (`execution_id != builder.execution_id`).
3. **Generic Runtime & Model Attribution**:
   - `runtime_kind`: Runtime environment classification.
   - `model_attribution`: Tri-state model capture:
     - `observed`: Exact model string verified from provider response metadata.
     - `configured`: Requested or configured model string.
     - `unavailable`: Explicit sentinel when model string cannot be verified (never synthetic `"OK"` or fabricated).
   - Provider/model identity is telemetry and quality data, not a gate barrier.
4. **Challenge Lifecycle**:
   - The controller issues single-use challenges (`ISSUED`) bound to the candidate digest and base/head SHAs.
   - Challenges are completed (`COMPLETED`) upon verified review generation, and atomically marked (`CONSUMED`) when settled.
   - Challenge state lives in controller private storage outside Git worktrees; replaying consumed challenges fails closed.
5. **Review Policy**:
   - Default: 1 approving independent review is sufficient for normal PRs.
   - Policy Escalation: 2 reviews required only when explicitly configured or triggered by policy rules.
   - Anti-Approval Shopping: Substantive BLOCK verdicts are retained. Retrying without repairing the code is blocked.
   - Atomic Settlement: Bundles settle without partial approval.

### Three Distinct Stages

The reviewer architecture separates review, repair, and certification into three uncollapsed stages:

```
STAGE 1: BABEL DOGFOOD REVIEW
Normal Babel Chat + Reviewer Persona + Candidate Diff
       │
       ├── Continuous Babel daily-driver Chat dogfooding (compaction, router, memory, tools)
       └── Produces findings without stripping ChatEngine capabilities

STAGE 2: AUTONOMOUS EXTERNAL REVIEW & REPAIR
Native Coding Harness (Codex, Claude, Gemini, OpenCode) in Isolated Worktree
       │
       ├── Mode: Review (inspect, test, find) OR Repair (inspect, test, edit, commit candidate B)
       ├── Worktree Isolation: `createIsolatedWorktreeEngineeringAdapter` creates dedicated Git worktrees
       └── Automatic Lineage: Records `CandidateProducerLineage` (parent SHA, new SHA, producer identity)

STAGE 3: FINAL INDEPENDENT CERTIFICATION
Fresh Independent Certifier (distinct execution, not builder, not repair producer)
       │
       ├── Mode: Read-only, candidate-frozen, SHA/digest-bound
       ├── V3 Evidence with execution_purpose: 'FINAL_CERTIFICATION'
       └── Merge gate authority strictly requires Stage 3
```

#### Mutation Invalidation & Independence Rules
- **Ordinary review capability != certification authority**: A review session or repair proposal does not carry merge gate authority.
- **Repair capability != approval authority**: An agent modifying code under `--repair` cannot approve its own repair.
- **Mutation Invalidation**:
  $$\text{candidate } A \xrightarrow{\text{repair}} \text{candidate } B \implies \text{approval}(A) \ne \text{approval}(B)$$
  Any code modification produces a new candidate $B$. Prior approval of $A$ is instantly stale.
- **Fresh Execution Requirement**: The execution that produced candidate $B$ (`producer_execution_id` or `lineage.producer.execution_id`) CANNOT certify $B$. A fresh, distinct execution must independently inspect and certify exact $B$.
- **Same Agent Family Allowed**: Codex Agent A (repair) $\to$ Codex Agent B (fresh certifier) is fully valid provided execution and principal IDs are distinct and proven by the controller.

#### Evidence Execution Purpose
V3 evidence explicitly types `execution_purpose`:
- `DOGFOOD_REVIEW`: Telemetry and findings from normal Babel Chat dogfooding.
- `REVIEW_REPAIR`: Autonomous repair proposals or modified candidates.
- `FINAL_CERTIFICATION`: Read-only, frozen SHA/digest-bound attestation required for merge gate authority.
The merge gate strictly rejects `DOGFOOD_REVIEW` or `REVIEW_REPAIR` as merge authority. All layers (controller request, worker request, runtime, and evidence) must agree on `FINAL_CERTIFICATION` (`PURPOSE_LAYER_MISMATCH`).

## V2 Babel Chat Review Contract (Legacy / Compatibility)

Low-level V2 validation (`<!-- babel-controller-ai-reviews-v2 -->`) remains supported alongside
V3 (`<!-- babel-controller-independent-review-v3 -->`) for backward compatibility with existing
candidates and historical bases. V2 evidence records `review_provider: "opencode-go"` and
the `babel`/`chat` harness.


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
and controller-state reads are unavailable to it. The production reviewer's
credential is Babel-native: the approved resolver selects the first existing
helper in precedence order — an explicit test-injection path, then the
`BABEL_OPENCODE_GO_HELPER` environment override, then the canonical Babel helper
`~/.config/babel/get-auth-token.js`, and finally the deprecated Claude-named
fallback `~/.claude/get-auth-token.js`, retained only for older hosts. The
credential is invoked without printing it: its value stays in process memory and
never enters diagnostics, receipts, logs or published evidence. `readonly_sandbox`
in the receipt names this application/tool-enforced boundary, not an OS sandbox
or cryptographic proof of isolation.

The controller normalizes output and publishes through the existing owner
GitHub identity. The base-rooted evaluator re-fetches that live comment and
checks the owner numeric identity and complete body; a local evidence file is
not sufficient provenance.

For V3 independent-agent reviews, comments are published with the marker:
```html
<!-- babel-controller-independent-review-v3 -->
```
containing a serialized `host_review_handoff_v3` bundle with `independent_agent_review_v3`
reviews.

For legacy V2 reviews, comments are published with:
```html
<!-- babel-controller-ai-reviews-v2 -->
```
with an optional `harness` object:

```json
{
  "name": "babel",
  "mode": "chat",
  "version": "<64-lowercase-hex installation digest>",
  "source_sha": "<40-lowercase-hex trusted source commit>",
  "execution_id": "<same execution_id as the review>"
}
```

The merge gate evaluator accepts both V3 and V2 evidence bundles, ensuring full
backward compatibility while enabling modern controller-owned independent agent review.
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

The launcher retains its bounded finite process timeout unless the trusted task
controller has already written a renewable authority checkpoint to
`<state-dir>/jobs/<candidate-digest>/authority.json`. That checkpoint must bind
the exact repository, PR, base/head SHAs, candidate digest, task ID, execution
ID, fencing epoch, and externally owned allowance identity. The launcher only
restores and renews that authority; it never derives an allowance from the task
text, queue lease, timeout, or Chat budget. A missing checkpoint therefore keeps
legacy finite behavior, while an invalid, expired, stale, terminal, mismatched,
or symlinked checkpoint fails closed. Publication receives a final live PR check
and fenced authority admission immediately before the mutation.

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

## Orchestrated certification (current production V3 producer)

`tools/babel-pr-orchestrate.mts` is the orchestrator-friendly entrypoint that
produces authoritative V3 evidence (`independent_agent_review_v3` /
`host_review_handoff_v3`) from fresh subagent executions, so an active coding
agent no longer needs a separately scheduled Babel reviewer daemon:

```powershell
node babel-cli/node_modules/tsx/dist/cli.mjs tools/babel-pr-orchestrate.mts `
  --repo-root <trusted-git-clone> --state-dir <private-non-git-directory> `
  --pr <number> [--model <opencode-model>] [--publish] [--json]
```

What it does on the exact candidate:

1. Collects the candidate envelope and materializes an inert, read-only
   snapshot of the candidate tree (no checkout hooks, no dependency install).
2. Runs one or two fresh reviewer executions per the canonical policy
   (`babel-cli/src/services/reviewPolicy.ts`, also consumed by
   `mergeReadinessBroker.ts`) using `createOpenCodeReviewAdapter`
   (`opencode run --agent babel-reviewer` against a deny-by-default read-only
   agent config). Reviewer principals and execution ids are fresh; the runtime
   records `fresh_context: true` / `fresh_process: true`.
3. Requires `FINAL_CERTIFICATION`; an approve with blocking findings is never
   emitted as approval.
4. With `--publish`, posts the owner-authenticated V3 handoff
   (`<!-- babel-controller-independent-review-v3 -->`) so Trusted Control Plane
   automatically reevaluates the exact head.

Status is machine-readable (`COLLECTED`, `REVIEWING`, `BLOCKED`, `REPAIRING`,
`RETESTING`, `CERTIFYING`, `WAITING_FOR_CI`, `MERGE_READY`, `ESCALATED`) with
exit codes `0` certified, `2` blocked (repair required), `3` escalated.

**Execution independence, not model diversity.** The controlling rule is that
the reviewer is a genuinely fresh execution distinct from the builder and from
any repair producer. The same model/runtime is allowed. The controller rejects a
reviewer whose principal or execution equals the builder or the candidate
producer, and `runtime.controller_execution_id` must equal the reviewer
execution id. External adapters deliberately omit `requested_provider` /
`observed_provider` (attribution `unavailable`) rather than claim the
Babel-native `opencode-go` provider; model identity is recorded with the
existing `observed | configured | unavailable` tri-state and is never
fabricated.

**Repair.** The bounded review → repair → fresh-certification loop
(`babel-cli/src/services/reviewOrchestrator.ts`) supports review workers plus an
optional repair worker (`AutonomousEngineeringWorkerAdapter.repair`), records
producer lineage for each repair, and re-collects the new head so the prior
approval is invalid. The CLI entrypoint is review-only: on a blocking finding it
returns `BLOCKED` with the findings so the orchestrating agent repairs and
re-runs certification. A BLOCK of an unchanged candidate cannot be re-reviewed
into approval (anti-approval-shopping).

**Policy note.** The base-rooted PowerShell gate still enforces a floor of one
independent review for every non-BLACK lane; `reviewPolicy.ts` is the single
TypeScript source of truth and preserves that floor (AMBIGUOUS/unknown lanes keep
the historical ELEVATED-equivalent strength).

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

The reviewer output budget is a compile-time 32k completions
(`REVIEW_OUTPUT_TOKEN_BUDGET`), shared by the request body and the advertised
model policy so the two cannot drift. Native-response buffers are sized above
that budget, so the configured output budget — not an event or byte buffer
guard — is the practical truncation limit on a legitimate long answer.

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
