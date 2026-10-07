# Coding-loop simplification and adversarial audit

## Result and delivery status

The ordinary Chat loop now has a concise model contract, atomic repository instructions, operation-scoped tool advertisement, optional planning/delegation, evidence-based progress, and one native completion protocol. Runtime authority and evidence remain separate from model prose. Independent review found and drove fixes for certification retirement, unknown command effects, LSP admission/discovery, restricted native completion, and repository-revision edge cases.

This is a locally implemented campaign with a concrete branch and PR draft. Delivery is blocked by the repository's required preflight: Git reads succeed, but authenticated `gh` and the required repository-local credential helper are unavailable. No push, PR creation, merge, or deployment is claimed. Hosted checks and paid multi-model evaluations have not run.

The final required preflight exited 1 on a clean committed checkout: authenticated `gh` and the repository-local helper are missing. Its dependent metadata checks could not qualify; independent Git/public reads still confirm the intended repository and main. No push was attempted.

## Repository ground truth

- Current fetched `main`: `2aa0200dcf65a18d80183a8eecd5e5c370c9f7f3`.
- Continuation: `22b30aed038a8b133af469502079398c1878c933`, four commits ahead and zero behind main. This was verified by fetch, not assumed from the assignment.
- Campaign branch: `codex/coding-loop-simplification-20261006`.
- An isolated clone and frozen comparison worktree were used. No pricing edits were present in that clone, and no other checkout was changed.
- Final remote refresh found unrelated open PRs #312 and #313; #313 superseded the earlier desktop draft #308. No campaign PR exists yet. Relevant earlier merges include #311, #309, #301, and #294.

Executable source is frozen at `674e9ad4c81a3c4ea59b9b1f67f0b68fc080f6d9`. The final audit-only commit preserves the tested source; final branch head and delivery status are reported in the handoff.

## Audit coverage and artifacts

The pre-change matrix has 411 rows; the current matrix has 431 rows. The matrix and source census record all discovered in-repository behavioral owners and delivery entrypoints. The repository-wide census covers source, documentation, scripts, configuration, root instructions, catalog overlays, and contributor skills. Every one of the 195 catalog entries and all 17 tracked contributor-skill entrypoints is mapped. Search hits nominate candidates; traced callers establish model delivery.

- [Instruction and capability matrix before changes](instruction-capability-matrix.jsonl)
- [Current matrix](instruction-capability-matrix-current.jsonl)
- [Source census and delivery-path evidence](source-census.json)
- [Architecture and mechanism-by-mechanism decisions](DECISIONS.md)
- [Complete effective inputs before changes](effective-inputs-before.json)
- [Complete effective inputs after changes](effective-inputs-after.json)
- [Prompt and tool measurements](prompt-tool-metrics.json)
- [Twenty behavioral cases and additional adversarial controls](behavior-evals.json)
- [Independent review history, including rejected revisions](review-history.json)
- [Verification record](verification.json)
- [Prepared PR description](PR.md)

External coding-agent hosts, user-installed MCP servers, future user context and externally installed skills are opaque content boundaries. Their entrypoints are mapped; unseen external contents are not claimed as audited. The direct embedded LSP service remains separate from ordinary Chat and depends on its embedding caller's authority.

## Important findings and decisions

The packet's prompt duplication, completion contradiction, stale command description and AGENTS budget concerns were reproduced. The argv implementation was already quote-aware: quoted whitespace and empty arguments needed accurate documentation, not a new parser. The suggested per-tool circuit reset was the wrong place to retire live certification because successful tools call it; task retirement now invalidates an epoch captured before any await. General SWE intentionally retains `required` verification, which may end honestly unverified after failure; the documentation no longer calls this `strict`.

Additional findings included incomplete manifest source identity, text mode dropping caller policy, direct engines compiling provenance without delivering the same repository context, duplicate completion recovery controls, and no-change tasks being pressured to create a patch. The new no-change path requires successful inspection and known effects; it cannot certify a patch.

Independent review rejected two intermediate revisions. Repairs closed unknown background effects, late certification resurrection, host-fallback-as-LSP-authority, a hidden installing `npx` discovery probe, and restricted native `finish`. A further review exposed nested-project Git status paths bound against the wrong root and historical receipts left fresh without an evaluable scope. The corrected receipt path requires content-bound repository evidence and rejects unknown currency. Parent symlinks are rejected before hashing file contents, while legitimately deleted tracked directories retain a known-missing digest. Review history preserves the rejected heads instead of re-labeling them as approved.

## Architecture and removed complexity

Host/user authority precedes the small Babel contract and complete root repository contract. Task-relevant guidance and current conversation evidence follow. Runtime policy decides tools, task scope, leases, approvals, path containment and resource limits. The model chooses investigation, edits, planning, delegation and relevant checks. Executed evidence and revision currency decide what may be claimed.

Ordinary Chat uses `inspect → answer` or `inspect → edit when needed → verify → answer`. Native schemas are its tool manual, and native final text proposes completion to the runtime gate. Legacy text/JSON retains its supported explicit protocol. Large Plan/Deep catalog workflows stay confined to their active specialized runners.

Always-loaded AGENTS shrank from 11,870 to 3,093 characters. Detailed Git, PR, release, credential and maintainer procedures remain in the on-demand contributor guide. Duplicate workflow sections, native tool prose catalog, repeated line-count edit advice, generic stack reminders and default phase-plan prose no longer reach ordinary model requests. `CLAUDE.md`, `BABEL.md`, `PROJECT_CONTEXT.md` and contributor skills do not silently compete with ordinary Chat's root contract.

Existing read/edit APIs and `run_command`/`test_run` remain compatible. A new `verify` alias was rejected because the receipt and evidence layer already owns verification semantics. Change tasks retain useful optional web/MCP/delegation tools; finer demand loading is not claimed as implemented. Read-only projections omit mutation and external-effect tools. LSP is withheld from ordinary Chat until its actual process can pass governed admission.

## Before and after

Measurements use `cl100k_base` as a fixed comparison tokenizer, not billed tokens for any provider. The 16 scenarios include all requested task/protocol/session cases, a real child loop with scripted transport, separate read-only text/JSON paths, and an explicitly injected restricted-native state. The capture script uses real Chat preparation and runner invocation with transport stubbed. Snapshots are request measurements, not coding-success evaluations.

| Scenario | Before chars / tokens | After chars / tokens | Sources | Tools | Workflow headings |
|---|---:|---:|---:|---:|---:|
| trivial-read-only | 17,508 / 3,851 | 4,380 / 875 | 8 → 6 | 21 → 8 | 2 → 0 |
| deep-audit | 17,508 / 3,851 | 4,380 / 875 | 8 → 6 | 21 → 8 | 2 → 0 |
| one-file-fix | 19,100 / 4,178 | 4,380 / 875 | 8 → 6 | 21 → 19 | 3 → 0 |
| multi-file-swe | 19,659 / 4,302 | 4,380 / 875 | 9 → 6 | 21 → 19 | 3 → 0 |
| investigate-then-fix | 19,100 / 4,178 | 4,380 / 875 | 8 → 6 | 21 → 19 | 3 → 0 |
| explicit-no-edit | 17,508 / 3,851 | 4,380 / 875 | 8 → 6 | 21 → 8 | 2 → 0 |
| governance | 17,508 / 3,851 | 4,380 / 875 | 8 → 6 | 21 → 8 | 2 → 0 |
| verifier-command | 19,222 / 4,206 | 4,416 / 883 | 9 → 7 | 21 → 19 | 3 → 0 |
| reused-tui | 17,503 / 3,851 | 4,375 / 875 | 8 → 6 | 21 → 8 | 2 → 0 |
| native-tools | 19,100 / 4,178 | 4,380 / 875 | 8 → 6 | 21 → 19 | 3 → 0 |
| native-restricted | 19,100 / 4,178 | 4,380 / 875 | 8 → 6 | 8 → 7 | 3 → 0 |
| text-tools | 13,161 / 2,914 | 5,269 / 1,112 | 5 → 4 | 12 → 13 | 0 → 0 |
| legacy-json | 20,211 / 4,481 | 7,788 / 1,647 | 8 → 6 | 18 → 19 | 3 → 0 |
| text-read-only | 13,161 / 2,914 | 4,385 / 907 | 5 → 4 | 12 → 4 | 0 → 0 |
| legacy-read-only | 18,634 / 4,157 | 6,053 / 1,272 | 8 → 6 | 18 → 8 | 2 → 0 |
| subagent-invocation | 1,309 / 313 | 1,309 / 313 | 3 → 3 | 7 → 7 | n/a → n/a |

The workflow column counts three named repeated headings, not every semantic overlap. Schema size is measured separately: current normal change requests expose 19 native tools with 11,480 schema characters; read-only requests expose eight with 3,259 schema characters. Native manual characters are zero. The complete JSON measurements retain before/after tool descriptions, source counts, request sizes and supplemental messages.

## Behavioral evidence

The deterministic evaluations exercise real engine/tool/evidence boundaries with scripted provider decisions. They include read-only explanation/audit, existing-correct code, single- and multi-file changes, failing verifiers, demonstrated baseline failures, unavailable execution, explicit dry run, stale verification, quoted arguments, repeated exploration, productive long investigation, explicit no-edit, mixed investigate/fix, child evidence, optional delegation/web, synthetic current-information search, and interrupted recovery.

The frozen before/after 18-file investigation is a direct comparison: 23 provider requests and `BLOCKED_POLICY` became 19 requests and `NO_CHANGE_REQUIRED`, with zero changed files in both. The old native replay did not emit mutation-pressure messages, so that result is attributed to removal of false no-change blocking, not an invented measured phase-pressure effect.

A real Git fixture with already-correct code and an explicitly requested `npm test` now finishes as `NO_CHANGE_REQUIRED` after three provider requests, retaining the executed passing receipt without claiming a verified patch. Actual temporary-file checks cover later mutation invalidation, distinct quoted argv and exact-repeat verifier cache reuse. The baseline-red case executes its verifier before, during and after an unchanged investigation, proving that failure was pre-existing in that fixture.

These results do not measure live-model diagnosis quality, average clarification rate, paid token cost, latency improvement, or relative strong/cheap/non-OpenAI model performance. No configured live credentials were available; no paid inference was invoked. Offline provider-adapter tests exercise supported request preparation, but cannot establish live cross-model non-regression.

## Independent source review

Independent source review found no remaining findings at `674e9ad4c81a3c4ea59b9b1f67f0b68fc080f6d9`. It covered the full main-to-source diff, including the inherited continuation segment, and preserved two earlier rejection reports. The later audit-only delivery head is checked separately; review grants no merge or deployment authority.

## Runtime protections retained

Profile/task scope intersection, explicit denials, authority leases/PDP, approval, realpath containment, secret paths, safe child environments, network/external-action restrictions, destructive Git/deploy/merge authority, effect transactions and recovery, owner generations, resource ceilings, command identity, simulated-execution rejection, verifier ledgers, revision binding, stale invalidation and exact evidence remain enforced below the model. Contributor scans and independent exact-head review remain required. No policy baseline, scanner allowlist or authority gate was weakened.

## Change size and reviewability

The proposed direct-base diff contains 101 paths, 31,340 additions and 1,696 deletions, including the complete machine-readable audit and before/after request snapshots. The reviewed source slice before final artifacts contained 44 runtime/capture files (+1,254/−1,231), 41 tests (+2,904/−422), three policy/procedure files and three initial audit files. This exceeds the advisory size targets; the audit, implementation, lifecycle/evidence repairs and final measurement artifacts are separated into coherent commits. No unrelated pricing work is included.

## Verification and limitations

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
| Public-content policy | Pass, exit 0 |
| Strict public secret scan | Pass with required gitleaks 8.30.1 in clean candidate worktree |
| Delivery preflight | Blocked, exit 1: authenticated gh/local helper unavailable |

All source checks above ran at the frozen revision. Counts are per command and overlap; the 22 test files mapped by the behavioral inventory are all covered. The public-content policy and strict secret scan pass. The strict scan ran on a clean candidate worktree containing all committed files; generated untracked test checkpoints remain preserved outside the release tree. Scanner policy and allowlists are unchanged. Remote delivery remains blocked by authentication.


The verification record gives commands, terminal counts, source revisions and the distinction between current checks and baseline/environment diagnostics. The 760-file unit selection was exercised in batches earlier in the campaign; environmental failures were reproduced on the frozen baseline and corrected in the command environment or build prerequisites. One batch lacked a valid aggregate footer, so its 40 files were rerun individually with complete terminal results. No single all-green 760-file aggregate is claimed.

Scoped CI environment settings made PowerShell available, forced the expected color mode, and selected an always-on tracing sampler. A numeric Node test-worker identity fix repaired a Node 24 fixture incompatibility while preserving rejection of untrusted environment injection. The `tsx` CLI could not bind its IPC socket in this environment; test launches used `node --import tsx` over the package-declared selections, with the no-ambient-inference guard retained.

Remaining limits are specific: delivery preflight authentication; unrun hosted/Windows checks; unmeasured live-model performance; non-Git whole-repository evidence stays unverified; ordinary Chat LSP is unavailable pending governed process admission; and fine-grained external-tool demand loading and active legacy API migrations remain outside this coherent change.
