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

## Change contracts and regression evidence

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

New mechanism: explicit operation input with AUTO fallback, novelty-based progress/recovery for ordinary Chat, explicit fresh-task certification retirement.

Why simpler: use the existing progress/evidence owners rather than another mutation-pressure authority.

Why safe: resource ceilings, action admission, current-revision verification, no-progress recovery and failure-localization gates stay enforced. Successful-tool circuit reset does not clear same-task certification.

Evidence: distinct-read investigation versus identical rereads, no-change task completion, explicit READ_ONLY with mutation-shaped text, profile denial despite CHANGE, fresh task versus continuation, dry-run and stale receipt rejection.

## Implementation plan and ownership

The owner's packet authorizes proceeding after this internal decision; no further approval is required for these scoped changes.

- [ ] **A: Prompt/stack slice.** Own `chatToolDefinitions.ts`, `chatStackCompile.ts`, `instructionManifest.ts`, their focused tests, text-protocol description owner, root AGENTS and procedural extraction. Preserve public action parameter names. Run focused tests before/after. Do not edit ChatEngine or shared runtime policy.
- [ ] **B: Control/lifecycle slice.** Own `toolExecutor.ts`, `chatZeroWritePolicy.ts`, `policyShadow.ts` and focused runtime tests. Retire task certification through an exported lifecycle function; root integrates the ChatEngine hook. Use existing progress receipts rather than inventing another detector. Preserve resource, lease, recovery and evidence gates.
- [ ] **Root: integration and behavioral instrumentation.** Own ChatEngine, operation/preparation contracts, request snapshots, evaluator fixtures, Deep wording, manifest/test inventory integration, audit artifacts and all Git writes. Run baseline comparison from the frozen original revision.
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
