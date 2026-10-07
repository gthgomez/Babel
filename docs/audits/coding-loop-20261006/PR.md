# Simplify ordinary Chat and harden capability/evidence boundaries

## Problem

Ordinary coding tasks received overlapping workflow instructions, a second native tool manual, oversized repository delivery procedures, and competing completion/control protocols. Several decisions depended on model prose or write counts even though runtime capability, progress and receipt machinery already existed. That combination wasted context, could block productive no-change investigations, and concealed authority/evidence inconsistencies.

## Behavior after this change

Read-only tasks inspect and answer. Change tasks inspect, edit when needed, verify proportionally, and answer. Planning, TODOs, delegation and research remain optional. Native final text proposes completion to one runtime gate; text/JSON compatibility paths retain their required explicit protocol.

- Deliver one concise core contract and an atomic root AGENTS contract. Whole optional sources are packed or explicitly omitted, never silently sliced mid-rule. Fresh, direct and reused Chat engines deliver the same compiled context that their provenance manifest records.
- Prefer explicit caller operation (`AUTO`, `READ_ONLY`, `CHANGE`) over heuristic defaults. Task classification cannot grant runtime authority; explicit denials still narrow the task. Advertise eight read-only tools or 19 ordinary change tools; retain useful optional web/MCP/delegation in change mode.
- Use existing evidence novelty and bounded recovery instead of ordinary write-count pressure. Permit inspected, effect-known `NO_CHANGE_REQUIRED` completion without manufacturing a patch.
- Bind executed verification to command identity and current file/repository contents. Passing no-change verification requires real Git-backed repository evidence. Unknown, simulated, failed or stale evidence cannot certify a patch.
- Retire certification by task epoch before asynchronous settlement, so late old-task work cannot restore authority. Withhold ordinary Chat LSP until it has governed process admission; discovery no longer installs packages or launches a probe.

## Adversarial audit and architecture decisions

The audit maps repository instruction sources, catalog routes, skills, provider boundaries, task controls, capabilities, denials, budgets, completion and evidence. Full findings, source census, decisions and measurements are in [the audit report](https://github.com/gthgomez/Babel/blob/codex/coding-loop-simplification-20261006/docs/audits/coding-loop-20261006/RESULTS.md) and its linked artifacts.

Confirmed hypotheses include duplicate workflow instructions, native `finish` alongside natural completion, an inaccurate command-quoting description, prompt-budget truncation, oversized always-loaded AGENTS, and write-count-based interference. The command implementation was already quote-aware; the contract was corrected without replacing its parser. General SWE retains honest `required` verification instead of imposing `strict` universally. Existing read/edit APIs and `run_command`/`test_run` remain compatible; a new `verify` alias was not justified.

Independent review rejected two intermediate revisions and drove repairs for unknown background effects, late certification resurrection, LSP authority/discovery, restricted native completion, nested-project revision paths and historical receipts with unavailable scope. Additional containment review rejected symlink-parent traversal while preserving known deleted-file evidence. The review history preserves rejected heads and repair provenance.

## Removed or demand-loaded instructions

AGENTS shrinks from 11,870 to 3,093 characters. Detailed Git/PR/release/credential/maintainer procedures move to an on-demand guide subordinate to AGENTS. Duplicate workflow sections, the native prose tool catalog, repeated line-count editing advice, generic stack reminders and default phase-plan prose leave ordinary Chat. Specialized active Plan/Deep catalogs and supported text/JSON protocols remain separate, explicit paths.

## Retained safety and authority

Runtime profile/task scope intersection, leases/PDP, approval, containment, secret handling, safe process environments, external-action limits, resource ceilings, effect transactions, cancellation/recovery, verifier ledgers, revision binding and stale-evidence rejection remain in force. Deployment/merge/destructive-history authority and independent review are unchanged. No scanner allowlist, policy baseline or authority gate is weakened.

## Measured evaluation

System/developer instructions, excluding separately measured tool schemas:

| Scenario | Characters before → after | Comparison tokens before → after | Tools before → after |
|---|---:|---:|---:|
| Read-only | 17,508 → 4,380 | 3,851 → 875 | 21 → 8 |
| One-file fix | 19,100 → 4,380 | 4,178 → 875 | 21 → 19 |
| Multi-file SWE | 19,659 → 4,380 | 4,302 → 875 | 21 → 19 |
| Explicit verifier | 19,222 → 4,416 | 4,206 → 883 | 21 → 19 |
| Text protocol | 13,161 → 5,269 | 2,914 → 1,112 | 12 → 13 parser actions |

The fixed comparison tokenizer is `cl100k_base`, not a provider billing claim. Sixteen full request snapshots include reused engines, restricted native mode, read-only text/JSON and an actual child loop with scripted transport.

Twenty required behavioral cases plus review regressions exercise real engine/tool/evidence boundaries with scripted provider decisions. The identical 18-file investigation changes from 23 requests and `BLOCKED_POLICY` to 19 requests and `NO_CHANGE_REQUIRED`, with no writes in either. A real Git/no-change fixture executes its requested verifier and ends honestly without claiming a verified patch. No live-model quality, latency, paid-cost or cross-model non-regression claim is made.

## Validation and independent review

Source revision: `674e9ad4c81a3c4ea59b9b1f67f0b68fc080f6d9`.

| Check | Exact outcome |
|---|---|
| `npm run typecheck` | Pass, exit 0 |
| `npm run build` | Pass, exit 0 |
| `chat-truth` | 925 passed, 3 skipped, 0 failed; exit 0 |
| `harness-runtime` | 882 passed, 1 skipped, 0 failed; exit 0 |
| `campaign-unit` | 283 passed, 0 skipped, 0 failed; exit 0 |
| `behavior-supplement` | 7 passed, 0 skipped, 0 failed; exit 0 |
| `tools/validate-all.ps1` | All three catalog/skill/routing validations pass |
| `tools/check-architectural-budget.ps1` | All four checks pass |
| `policy-integrity-manifest.mjs verify` | 124 covered files verified |

The required test selections use `node --import tsx` because the `tsx` CLI cannot bind its IPC socket in this environment; selected files and no-ambient-inference protections are preserved. All 22 files mapped by the behavioral inventory ran at this revision. Counts overlap and are not a unique-test total.

Independent source review and final public scan status are recorded in the audit package after completion.

## Independent source review

Independent source review found no remaining findings at `674e9ad4c81a3c4ea59b9b1f67f0b68fc080f6d9`. It covered the full main-to-source diff, including the inherited continuation segment, and preserved two earlier rejection reports. The later audit-only delivery head is checked separately; review grants no merge or deployment authority.

## Scope, dependencies and delivery

Continuation source: `22b30aed038a8b133af469502079398c1878c933`; current main base: `2aa0200dcf65a18d80183a8eecd5e5c370c9f7f3`. The continuation was fetched and verified four commits ahead of main. This PR includes that prior verifier work plus coherent audit, implementation and review-repair commits.

The proposed direct-base diff contains 101 paths, 31,275 additions and 1,696 deletions, including the complete machine-readable audit and before/after request snapshots. The reviewed source slice before final artifacts contained 44 runtime/capture files (+1,254/−1,231), 41 tests (+2,904/−422), three policy/procedure files and three initial audit files. This exceeds the advisory size targets; the audit, implementation, lifecycle/evidence repairs and final measurement artifacts are separated into coherent commits. No unrelated pricing work is included.

No unrelated V4.1 pricing changes are included. The isolated clone contained none; other checkouts were untouched. No dependency/lockfile migration, deployment or merge was performed. The draft was prepared locally; authenticated delivery preflight and hosted PR checks remain necessary before remote readiness.

## Limitations and deferred work

Live high-capability, inexpensive and non-OpenAI inference evaluations were unavailable without configured credentials and were not invoked. Hosted/Windows checks have not run locally. Ordinary Chat LSP remains unavailable until governed process admission exists. Non-Git whole-repository receipts remain unverified. Finer web/MCP/delegation demand loading and an incompatible unified-tool migration are deferred; this change does not claim those migrations are complete.
