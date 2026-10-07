# Coding loop simplification: audit and implementation decisions

## Scope and authority

The campaign starts at `22b30aed038a8b133af469502079398c1878c933`, four commits ahead of `main` at `2aa0200dcf65a18d80183a8eecd5e5c370c9f7f3`. A fresh clone and frozen comparison worktree protect work outside this campaign. The owner authorized implementation, branch push, and PR creation; merge and deployment are excluded.

The baseline instruction and capability inventory is `instruction-capability-matrix.jsonl`. It has one JSON object per surface, including each registered catalog entry, local tool, native tool, contributor skill, and identified runtime/prompt owner. Field names map directly to the assignment's columns; `tokenContextCost` uses characters or explicitly approximate tokens, not provider billing. This is a delivery-path audit: external CLI hosts, user-installed MCP servers and arbitrary future user files have opaque content. Their entry points are inventoried; their unseen contents are not represented as inspected.

## Architecture decision

Keep the three existing boundaries: runtime capability admission, model engineering judgment, and evidence-backed completion. Simplify the ordinary Chat contract and its task-local control logic. Preserve the specialized Plan/Deep protocol and existing edit APIs; they have active callers and materially different contracts.

The normal loop is `inspect → answer` or `inspect → edit when needed → relevant verification → answer`. Planning, TODOs, research, and delegation remain techniques. Native responses finish through a natural-language final response evaluated by the existing completion authority. Text/JSON compatibility parsers remain supported; old transcripts are not rewritten.

### Alternatives considered

1. **Rewrite every tool and controller:** rejected. A wholesale `edit_file`/`create_file`/`verify` migration changes compatibility and evidence mapping without evidence of better task outcomes.
2. **Delete prompt text only:** rejected. This leaves truncated repository contracts, task-scope state reuse, and investigation pressure intact.
3. **Consolidate the prompt, make required context atomic, and remove redundant control pressure:** selected. Existing runtime and evidence owners continue enforcing their invariants; deterministic evaluations cover the changed contracts.

## Hypothesis dispositions

| ID | Finding at the baseline | Decision |
|---|---|---|
| H1 | Core Principles, How You Work, Recommended Workflow, safety and verifier snippets repeat overlapping advice. Session identity loader is already empty, so AGENTS is not duplicated through that old path. | MERGE common advice into one short behavioral contract. |
| H2 | Native prompt permits natural answers but later says to use `finish`; the runtime already accepts native natural completion and gates it. | REMOVE `finish` from new native advertisements; retain compatibility parsing and runtime gate. |
| H3 | There are 21 native schemas; handwritten native/legacy table omits LSP and separately maintains parameter descriptions. Text mode returns early and has a distinct supported pseudo-tool protocol. | REMOVE native prose table; generate legacy guidance from schemas. Keep text protocol documented in its own canonical owner. |
| H4 | Shared parser preserves quoted whitespace and empty arguments. The native description incorrectly claims whitespace-only splitting. | SIMPLIFY description to match executor; retain quote-aware parser and verifier identity. |
| H5 | Root AGENTS is 11,870 characters. A 12,000-character stack reserves other snippets and then prefix-truncates optional identity; pre-read cap is separately 12,000. Packing can break before user context. | REPLACE prefix truncation with complete required AGENTS or explicit context error; optional sources are admitted whole or omitted, with disposition. |
| H6 | Always-loaded AGENTS contains extensive PR, release, history-repair, and maintainer procedure. | DEMAND-LOAD detailed procedures through a short root contract; retain all actual authority and scan requirements. |
| H7 | Live certification survives unrelated submissions sharing `engineRunId`. The named reset helper is called after successful tools, so deleting certification there would break mutation→verify. | MOVE cleanup to fresh-task/disposal lifecycle; preserve explicit continuation and same-task evidence. Do not claim unbounded memory growth was reproduced. |
| H8 | `required` can return an honestly unverified warning for failed verification; `strict` requires passing evidence. General SWE uses required. | KEEP runtime policy; fix contradictory explanatory text. A failure is never upgraded to verified. |
| H9 | Distinct evidence progress is already recorded, but separate write-count/exploration policies still nudge, restrict, or cap productive inspection. | REPLACE ordinary write-count pressure with existing novelty/progress authority. Keep wall/token/cost limits and no-progress recovery. |
| H10 | Task-text classifiers narrow task behavior; actual authority remains in profile, lease, approval, scope and execution gates. No regex-alone capability grant reproduced. | SIMPLIFY by accepting explicit caller operation before AUTO heuristics; explicit READ_ONLY never widened. Preserve runtime admission independently. |
| H11 | Read/file/range and replacement/patch/whole-file tools differ materially. Parameter names are public compatibility. | KEEP APIs, remove repeated arbitrary 50-line advice; use semantic descriptions. No destructive API migration. |
| H12 | `test_run` and `run_command` converge on governed execution; authoritative verification comes from receipts, scope and current revision, not the tool name. | KEEP APIs; describe execution versus accepted verification evidence precisely. A new `verify` alias would add another surface. |

## Additional findings

* Compiled-stack manifest rows can use the 200-character preview as source identity while exact delivered digests already exist in the compiler. Inline identity fragments are separately correct. Bind compiled rows to complete source and delivered content, including omissions.
* Stack estimates exclude the Chat core, schema JSON, repo map, caller append context and preflight. Effective request capture must measure those components, with the measurement layer clearly named.
* Text mode drops caller append context along with optional orientation data. Caller policy cannot be discarded merely because a small-model protocol was selected; parity tests must cover the deliberate context boundary.
* Deep executor prose claims all files not explicitly excluded are authorized. An approved plan and QA verdict do not grant that authority. Narrow this wording to the plan and runtime grants while preserving Deep's actual plan gate.
* No live API credentials are configured in this execution environment. Behavioral replay uses scripted providers and real runtime/tool/evidence boundaries; it is not a live-model intelligence or cost benchmark.
* An actual engine replay reproduced a second mutation-pressure mechanism at completion: correct code read once followed by a truthful no-change answer triggers `completion prefers patch` repeatedly and finally fails. Remove this separate veto, admit inspected no-change conclusions through the existing completion gate, preserve explicit verifier requirements, and project `NO_CHANGE_REQUIRED` without certifying a patch. Regression: `codingLoopSimplification.test.ts`, plus adversarial no-inspection/failed-inspection/explicit-verifier gate tests.
* Direct ChatEngine callers could compile a manifest without installing that repository context in the request. Use one compiled-stack object for delivery and provenance; direct callers compile it, prepared callers supply it, and reused preparation replaces it. Required-policy overflow must fail before provider dispatch on every path.

## Change contracts and regression evidence

### D0 — Independent review correction: LSP discovery

Old mechanism: when no local TypeScript language server exists, manager discovery runs `npx --yes typescript-language-server --version`, then registers another `npx --yes` command.

Problem: discovery can install and execute package code, inherit ambient credentials, and use the network before the sanitized language-server client starts. The first safe-environment fix did not cover this earlier spawn. Independent review of `069509b` identified it.

Real invariant: selecting code intelligence does not authorize installing dependencies or running a credential-bearing package probe.

New mechanism: discover an already installed server without executing a probe; otherwise report no server. The embedded service retains explicit project server configuration and a sanitized client environment. Ordinary Chat withholds LSP at both schema projection and dispatch until an adapter can admit the actual process through its lease/authority boundary; host fallback alone is isolation configuration, not action authority.

Why simpler: removes a hidden process/network/install path and its fallback behavior.

Why safe: installed/configured servers remain usable by the embedded service under its caller authority. Ordinary Chat retains local read/search tools and does not expose an ungoverned process. Dependency installation, when actually needed and authorized, uses the ordinary governed command path rather than a hidden LSP side effect. No new authority flag is introduced.

Evidence: a stubbed child-process reproduction of the old discovery path, a no-process/no-install discovery regression, installed-server/configured-server cases, and existing LSP client tests. This correction is a separate post-review commit; the reviewed original head is not presented as the corrected revision.

### D1 — Prompt and repository instruction delivery

Old mechanism: repeated workflow sections, a native Markdown tool manual, provider transport advice in a generic stack, arbitrary line-count edit advice, large always-loaded delivery procedure.

Problem: contradictory completion guidance and multiple documentation owners; ordinary edits inherit unrelated release ceremony.

Real invariant: the model must know its assignment, repository conventions, granted scope and honest verification responsibilities.

New mechanism: one concise common contract, native schemas as the tool manual, protocol-specific response guidance, concise root AGENTS with explicit procedural links.

Why simpler: each concern is stated at its owner; irrelevant procedure loads only when the task needs it.

Why safe: no executor, lease, approval, secret, path or merge gate is removed. Contributor procedure is retained, not waived.

Evidence: prompt snapshots across native/text/legacy, tool-name/schema parity, quoted-argv tests, relevant existing prompt/stack tests and public policy manifest verification.

### D2 — Atomic policy and instruction provenance

Old mechanism: pre-read caps and budget prefix truncation, followed by a loop break; manifest may hash preview content.

Problem: a required rule can be cut mid-sentence and source changes beyond the preview may be invisible to manifest identity.

Real invariant: required repository policy is either present in full or dispatch is refused; recorded identity names actual source and delivery.

New mechanism: complete required sections, atomic optional packing that continues after an omitted source, explicit overflow/read errors and exact digest disposition.

Why simpler: one packing decision per source; no partial-rule semantics.

Why safe: required content cannot be silently omitted; optional context omission is inspectable.

Evidence: oversized/unreadable AGENTS, mandatory overflow, later user context, unicode boundaries, unchanged/changed tail digests and reused preparation regressions.

### D3 — Task operation, progress and certification lifecycle

Old mechanism: task classification repeated by callers; independent controls equate tool/write counts with progress; live certification keyed to engine run can survive a fresh user task.

Problem: capable investigation can be interrupted; caller intent may disagree with heuristic defaults; task evidence can outlive its intended task.

Real invariant: explicit denials and runtime capabilities remain binding, no-progress work stays bounded, same-task verification remains possible, later tasks cannot inherit certification.

New mechanism: explicit operation input with AUTO fallback, novelty-based progress/recovery for ordinary Chat, fresh-task certification retirement with a task epoch captured before asynchronous dispatch. Retirement invalidates the epoch so an old in-flight mutation cannot restore certification for a reused run ID.

Why simpler: use the existing progress/evidence owners rather than another mutation-pressure authority.

Why safe: resource ceilings, action admission, current-revision verification, no-progress recovery and failure-localization gates stay enforced. Successful-tool circuit reset does not clear same-task certification.

Evidence: distinct-read investigation versus identical rereads, no-change task completion, explicit READ_ONLY with mutation-shaped text, profile denial despite CHANGE, fresh task versus continuation, dry-run and stale receipt rejection.

### D4 — No-change conclusions and unknown effects

Old mechanism: a separate completion heuristic prefers a patch; change-task honesty starts from a required write. Initial simplification accepted a successful read as a no-change basis but missed process logs with no effect result.

Problem: already-correct code can provoke a manufactured change or a blocked result. Conversely, a background start or successful process exit says nothing authoritative about whether workspace bytes changed.

Real invariant: useful inspection may conclude no edit is needed; unknown effects cannot support that conclusion; a no-change answer is never patch certification.

New mechanism: require successful, nonempty inspection and no observed or unresolved mutation for a `NO_CHANGE_REQUIRED` conclusion. Direct mutation failures, indeterminate child effects, and process/await logs without `confirmed_no_change` reject that path. A reused verifier cache entry records no new effects because no process runs. Explicit verifier requirements still apply.

Why simpler: one evidence-based completion gate replaces the independent patch-preference loop; completion does not require a token edit.

Why safe: native final prose proposes completion, while canonical evidence and terminal authority decide the outcome. Missing, failed, simulated, stale and revision-mismatched verification is not promoted to success.

Evidence: real-engine already-correct fixture; no-inspection, failed-inspection, background-start and await adversarial controls; command-cache execution count and effect log; real stale-after-mutation fixture. Independent review R1 rejected the incomplete first version; it was corrected before delivery.

### D5 — Recovery feedback and native completion

Old mechanism: native natural completion and a `finish` schema coexist; restricted tools independently reintroduce `finish`. Completion rejection also competes with an immediate auto-continue and a separate text-only hard stop. Some injected advice is not represented as durable controller feedback.

Problem: protocols disagree, rejection can loop without the provider receiving reliable feedback, and recovered sessions may not reproduce the live request.

Real invariant: a model may propose completion, but it cannot approve its own evidence; interrupted sessions must preserve feedback provenance and outcome.

New mechanism: all native advertisements, including restricted sets, derive from the canonical native inventory without `finish`. Text/JSON compatibility retains its explicit finish protocol. Controller feedback is a durable, non-authoritative advisory message; one bounded completion-recovery allowance governs unsupported final claims.

Why simpler: one completion protocol per active transport and one recovery owner for rejected final claims.

Why safe: the final decision stays with runtime/evidence gates. Feedback is not a user instruction or authority grant. Critic/resource controls remain; ordinary no-progress advice is selected by the existing arbiter rather than injected twice.

Evidence: native and restricted-schema tests; real request snapshots; a scripted provider changes its next action after feedback; cold reconstruction reproduces that feedback; no-change and stale-proof terminal tests.

### D6 — Explicit verifier after an already-correct change request

Old mechanism: green verifier capture assumes a nonempty mutation-file scope. An actual successful verifier before any mutation can throw on empty file scope and leave a truthful no-change task blocked.

Problem: requiring a fake diff to obtain evidence contradicts inspected no-change completion.

Real invariant: verification must bind actual current contents; a root-path digest or an unchanged HEAD alone cannot establish workspace currency.

New mechanism: an explicit adapter route for a successful verifier with zero task writes and no mutation paths may bind the Git-backed repository contents. It remains subject to inspection, command identity, execution provenance and currency checks. An unavailable content binding stays unverified. Existing file-scoped mutation receipts keep their contract.

Why simpler: no-change tasks use the existing revision/evidence model without a manufactured mutation, a new tool, or an exception to honesty.

Why safe: no-Git path-only bindings cannot prove currency. A later repository change invalidates the evidence. This route can support a no-change conclusion; it does not create a patch or satisfy the verified-patch write requirement.

Evidence required before acceptance: red-first actual Git fixture with already-correct code and an explicitly required verifier; empty-scope default rejection; no-Git repository currency refusal; dirty/untracked content currency; simulated and stale controls. The final result records the implemented scope and executed checks.

## Explicit instruction hierarchy and retained boundaries

Host and user authority remain above all repository content. Ordinary Chat receives the small Babel behavioral/protocol contract, the complete applicable repository contract, explicitly supplied caller context and relevant task/conversation evidence. Optional skill/engineering guidance is loaded only through its declared owner. No inferred plan, tool description, model reply, repository file or review result creates execution authority.

**Removed from ordinary model requests:** duplicate Core Principles/How You Work/Recommended Workflow sections; native Markdown tool table; native `finish` schema including restricted sets; generic provider/safety/verifier stack snippets that repeat other owners; repeated 50-line edit advice; default phase-plan/pre-loop workflow prose; ordinary mutation-count interventions; duplicate completion retry protocols. Runtime implementations and compatibility-only helpers may remain when supported callers require them; the matrix names those delivery boundaries.

**Demand-loaded:** Git/PR/release/review/credential procedures in `CONTRIBUTOR_PROCEDURES.md`; optional ENGINEERING/domain context; explicitly selected skills; large Plan/Deep catalog, OS and domain overlays in their existing specialized runners. `CLAUDE.md`, `Claude.md`, `BABEL.md`, and `PROJECT_CONTEXT.md` are not silent ordinary Chat instruction sources. Product documentation and external host integrations remain separately inventoried.

**Runtime-only enforcement retained:** profile/task scope intersection; lease/PDP and action approval; project and realpath containment; secret path and safe-environment restrictions; network/external-action admission; destructive Git/deploy/merge approval; mutation effect transactions, cancellation, owner generations and recovery; resource ceilings; verifier execution provenance, command/argv/cwd/environment identity, revision binding, stale invalidation and cache currency; exact-revision completion and independent delivery review. This campaign does not reimplement those policies in the prompt.

**Deliberately retained compatibility:** `read_file`/`read_range`, focused replacement/patch/whole-file APIs, `run_command`/`test_run`, text and legacy JSON protocols, Plan/Deep staged workflows, and opaque third-party provider/MCP/skill entry points. Removing these active interfaces without behavioral evidence would be a migration rather than a simplification. Fine-grained web/MCP/delegation demand loading for change tasks remains a measured follow-up, not a claimed result here.

## Implementation plan and ownership

The owner's packet authorizes proceeding after this internal decision; no further approval is required for these scoped changes.

- [x] **A: Prompt/stack slice.** Own `chatToolDefinitions.ts`, `chatStackCompile.ts`, `instructionManifest.ts`, their focused tests, text-protocol description owner, root AGENTS and procedural extraction. Preserve public action parameter names. Run focused tests before/after. Do not edit ChatEngine or shared runtime policy.
- [x] **B: Control/lifecycle slice.** Own `toolExecutor.ts`, `chatZeroWritePolicy.ts`, `policyShadow.ts` and focused runtime tests. Retire task certification through an exported lifecycle function; root integrates the ChatEngine hook. Use existing progress receipts rather than inventing another detector. Preserve resource, lease, recovery and evidence gates.
- [x] **Root: integration and behavioral instrumentation.** Own ChatEngine, operation/preparation contracts, request snapshots, evaluator fixtures, Deep wording, manifest/test inventory integration, audit artifacts and all Git writes. Run baseline comparison from the frozen original revision.
- [ ] **Independent review.** Freeze exact changes, A reviews B and integration; B reviews A and integration. Reviewers do not modify or approve their own patch. Address concrete findings and rerun affected checks.
- [ ] **Delivery.** Run relevant suites, canonical typecheck/build, policy/secret scans, architecture budget and applicable hosted checks; inspect changed paths and base diff; push and open/update a PR. No merge or deployment.

## Review focus

1. A reused engine must rebuild operation and prompt/tool context without leaking the previous task's certification.
2. `READ_ONLY` is an upper bound even if quoted code or task keywords contain mutation verbs.
3. Failed, simulated, stale or wrong-command evidence must never become verified completion.
4. Productive multi-file investigation must not trigger a write-count stop; repeated identical evidence still needs bounded recovery.
5. Protocol simplification must preserve supported text/legacy callers and caller-supplied policy.

## Evidence ledger

Baseline: 121 focused tests passed, 0 failed; canonical `npm run typecheck` passed. An additional instruction-focused run reported 143 passing tests. These are baseline checks, not post-change evidence. Final measurements and exact delivered revision belong in `RESULTS.md` after verification.
