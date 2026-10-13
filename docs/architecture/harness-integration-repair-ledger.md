# Harness integration repair ledger

Audit source: *Babel harness architecture audit* (2026-10-12), revision `95f2cd35da0ce68c34a322e3ac32a49e5cef7d3e`.

Repair branch: `cursor/architecture-integration-repair-73b4` (PR #370).

| ID | Evidence | Implementation | Review | Verification |
|----|----------|----------------|--------|--------------|
| I01 | Confirmed | `CompactionRequestContext`; manager/heuristic eligibility; heuristic fallback on noop/cannot_fit | Lead + worker A | `architectureIntegrationRepair.test.ts` (I01), `chatCompaction.test.ts` |
| I02 | Confirmed | `OpenCodeGoApiRunner` execute/executeRaw/stream wrappers rethrow `PreparedRequestAdmissionError` before transport | Worker A + Bugbot (Composer 2.5 Fast; findings retained) | `architectureIntegrationRepair.test.ts` (I02): real adapter + mocked `fetch`, no `executeRaw` stub |
| I03 | Confirmed | Repo-map / preamble budget uses resident `estimateTokens(conversation)` (not cumulative `apiTokenCount`) | Worker A | `architectureIntegrationRepair.test.ts` (I03): `ensureRepositoryContext` + `getOrBuildSystemPrompt` twice with inflated `apiTokenCount`; `repoMapPreamble.ts` |
| I04 | Confirmed | `resolveCompactionSummarizationProvider` + engine wiring; no ambient cross-route for OpenCode Go | Worker A | `architectureIntegrationRepair.test.ts` (I04) |
| I05 | Confirmed | Compaction admission serializes via **runner-bound** `buildNativeToolsWireBody` on the live deliberation runner (DeepInfra/OpenCode-Go family → `openAiCompatibleNativeWire`; DeepSeek-direct → `deepSeekNativeWire`). Unsupported runners fail closed in `buildNativeCompactionAdmissionWireBody` (no OpenAI-shaped substitute). `buildNativeProviderRequestBodyForAdmission` remains a **test/helper** for OpenAI-compatible shape only—not production transport for DeepSeek or admission closure. Reserved completion budget matches transport: `getNativeRequestReservedCompletionTokens` uses `executionEnvelope.output.effective ?? maxTokens` (`deepInfraNativeReservedAdmission.test.ts` fails if only `maxTokens` is used while envelope effective differs). | Worker A | `openAiCompatibleNativeWire.test.ts`, `deepSeekNativeWire.test.ts`, `deepInfraNativeReservedAdmission.test.ts`, `chatEngineNativeWireAdmission.test.ts` (full-byte DeepInfra + DeepSeek receiver path), `architectureIntegrationRepair.test.ts` (I05 admission math), `compactionCommit.test.ts`, lifecycle/S07 |
| I06 | Confirmed | `runMutationAgentLoop` patch target authorization | Worker B | `architectureIntegrationRepair.test.ts` (I06) |
| I07 | Confirmed | Child effect receipts / hash-delta promotion | Worker B | mutation + child tests (prior slice) |
| I08 | Confirmed | Daemon crash recovery explicit `failed` (no silent requeue) | Worker B | `architectureIntegrationRepair.test.ts` (I08) |
| I09 | Confirmed | Async ripgrep + abort; grep tool forwards `context.signal`; 30s ceiling | Worker B + Bugbot | `architectureIntegrationRepair.test.ts` (I09), `ripgrep.test.ts` (7 native cases) |
| I10 | Confirmed | `snapshotComplete` workspace identity | Worker B | mutationTools tests (prior slice) |
| I11 | Confirmed | Plan read-only at executor kernel | Worker B | `architectureIntegrationRepair.test.ts` (I11), `kernel.test.ts` |
| I12 | Confirmed | Tool-result cache mutators; `localTools` invalidation wired to `TOOL_RESULT_CACHE_MUTATING_TOOLS` | Worker B + Bugbot | `toolResultCache.test.ts` |
| I13 | Confirmed | Read dedupe + `contextEpoch` | Worker B | `architectureIntegrationRepair.test.ts` (I13), `readWindow.test.ts` |
| I14 | Confirmed | Unknown cost allowance | Worker B | `architectureIntegrationRepair.test.ts` (I14) |
| I15 | Confirmed | Interrupted tool idempotency keys until settlement | Worker B | `architectureIntegrationRepair.test.ts` (I15), `sessionEvents.test.ts` |
| I16 | Confirmed | Provider failure taxonomy (connect vs read) + harness wall terminal reason | Worker B | `architectureIntegrationRepair.test.ts` (I16), `providerFailureReceipt.test.ts` |

## CI notes

- **ecaaa25** / **ae90805**: lifecycle compaction/S07 failures traced to harness-token ceiling + message-only admission probes — fixed by provider-window admission and shared native wire builder (`openAiCompatibleNativeWire.ts`, `buildNativeCompactionAdmissionWireBody`).
- **Windows ACL** (`acl_verification_timeout` at prior head): environment-sensitive; `runtime/admission.ts` adds one extended ACL verify retry. Not attributed to integration diff.
- **native-rg**: qualification script updated to **7** cases after abort-path test (coverage retained).

## Review receipts

- **Bugbot** (Composer 2.5 Fast, not user-requested model): ripgrep timeout + cache invalidation wiring — addressed in branch.
- **Independent review**: Composer 2.5 (non-Fast) re-review after lifecycle fixture typecheck fix + I05 ledger tightening (exact head SHA in PR).

## Honest limitations (not claimed complete)

- **I05 scope:** Byte parity between compaction admission and transport is **proven** for DeepInfra (incl. OpenCode Go subclass), DeepSeek-direct, and the ChatEngine receiver path (`chatEngineNativeWireAdmission.test.ts`). Runners without `buildNativeToolsWireBody` (e.g. Ollama native) are **unsupported**—admission throws rather than approximating another provider’s JSON. Not claimed: every catalog provider or host-port deliberation route.
- Broad host-port / reducer migration programs beyond documented projection boundaries and public-entry tests are **out of scope** for this PR.
- Full process-tree settlement under load for search cancellation is covered at abort/timeout seams, not exhaustive stress harnesses.
- Paid provider evaluations and release deployment were not authorized.

## Request context and workspace effect qualification

The following contracts extend the historical repair coverage. Source conformance,
deterministic fixtures, installed consumers and provider-backed task correctness
are separate evidence scopes. Hosted success does not establish a task-level
reliability rate.

| Boundary | Contract | Regression owner |
| --- | --- | --- |
| Raw fallback | Preserve the selected compiled system context. A native-to-legacy downgrade reconstructs both prompts with the destination protocol and retains retry lineage. | `chatEngineFallbackContext.test.ts` captures serialized receiver bodies for ordinary raw, both fallbacks and exact Go refusal. |
| Announced native calls | A provider failure after announcing calls settles them as failed before dispatch. It cannot create executable calls by retrying a different response protocol. | `chatEngineFallbackContext.test.ts`, `toolSettlementIdentity.test.ts` |
| Repository freshness | Confirmed or uncertain parent mutations expire graph tags, the map and rendered prompt caches before the next compiled request. Byte-equal/no-effect and isolated-child results preserve parent context. Superseded scans cannot install. | `chatEngineRepositoryContextFreshness.test.ts`, `r0ChildMutationFreshness.test.ts`, existing owner-fence fixtures |
| Child effect scope | `effect_status` describes certainty; additive `effect_scope` describes `parent_candidate`, `isolated_child`, or `unknown`. Only explicit parent scope contributes child effects to parent writes, progress and changed-file projection. Missing legacy scope is unknown. | `r0ChildMutationFreshness.test.ts`, `chatEngineCriticBudget.test.ts`, `toolCallExport.test.ts` |
| Recovery ownership | A hash comparison cannot exclude external writers during restore/delete. `WorktreeSafetyController` preserves current bytes and snapshots and returns `rollback_failed` when destructive recovery lacks exclusive writer evidence. It does not promise shared-checkout atomicity. | `worktreeSafety.test.ts` comparison interleaving; `codingLoopInvestigation.test.ts` patch, creation, deletion and external-writer controls |
| Pending writers | A pending background job does not prove a completed parent deliverable. Cancellation requests are separate from observed process exit. | `chatEngine.lifecycleQualification.test.ts`, `processTreeTermination.test.ts` |
| Late effects and resume | A prior passing parent test cannot certify bytes changed later by a detached owned writer. Cancellation retains that effect, process exit is observed, and resumed authority cannot reuse the old green receipt. | `chatEngine.lifecycleQualification.test.ts` connects real repair/test, cancellation, late write, observed exit and an independent red current-byte oracle. |
| Checkpoint process death | Actual process death during prepared journal, partial publication, context installation, committed journal and partial restore must recover one coherent generation. This does not establish power-loss durability. | `checkpointWindowsPersistence.test.ts` kills the exact child at observed publication boundaries and checks resumed bytes and intended context/thread state. |
| Scheduled attempts | Every scheduled preflight refusal has a distinct trial row. `attempt_accounting` includes those rows and distinguishes launched, not launched and unknown launch. Legacy validity-qualified rates remain separate. Missing cost is incomplete; cost per success is null when incomplete. | `eval/canary/canary.test.ts` |
| Grader and prose evidence | Grader unavailability is distinct from an observed oracle failure. Task success requires completed grading, hidden correctness and contract success; a hung correct patch is separate. Bounded English verification claims are graded against current parent receipts; incomplete, ambiguous or quoted claims remain unknown. | `eval/cleanRoomGrade.test.ts`, `eval/diagnostics/verification.test.ts`, `eval/canary/canary.test.ts` |
| Provider billing | OpenRouter's reported `usage.cost` is accepted only as a finite nonnegative amount; a malformed reported amount stays unknown. Missing reports retain the existing pricing estimate or unknown result. Buffered, structured streaming and native streaming preserve captured usage through normalization. | `providerResponseMetadata.test.ts`, `openRouterApi.test.ts` |

The changed log and metric fields are additive, but their semantics are **RISKY**
for consumers that inferred parent effects from child detail strings. In-repo
projections migrate together; external consumers must honor scope before treating
child paths as applied. Rollback requires reverting the scope migration together,
without upgrading old unknown-scope rows. Recovery refusal changes are also
**RISKY**: callers must preserve affected/indeterminate paths rather than report an
assumed restoration. The retained snapshots are evidence for a separately governed
recovery decision.

Isolated child findings remain reportable artifacts with workspace, parent
dispatch revision, actual committed child base and observed candidate postimages; they are explicitly unapplied.
Child success grants no parent incorporation permission. The legacy promotion
utility is not a production Chat transaction or fresh parent verifier receipt.
Authorized application through the parent executor invalidates prior proof and requires
a new parent verifier receipt (`r0ChildMutationFreshness.test.ts`). Supported finish
actions are synchronous and effect-free; deadline qualification belongs to preceding
nonterminal tools and their effects. Automatic promotion, exhaustive pending/late
reconciliation and checkpoint crash boundaries, general natural-language
claim grading, every provider transport and load behavior need their own connected
production-entry evidence before broader qualification claims.

On Windows without file-symlink creation privileges, the compiler fixture reports
that capability unavailable. Linux still requires the real symlink rejection;
`BABEL_REQUIRE_SYMLINK_FIXTURE=1` makes capability refusal fatal on a capable Windows
lane. The portable non-file intake case is a separate fail-closed check and does
not qualify Windows file symlinks.

Mock canary controls distinguish visible verification, hidden-oracle correctness,
no-op success, honest blocks and false completion. They do not measure a live model
or justify changing production budgets. Provider-backed paired campaigns require
frozen task/route/configuration/grader identities, declared spending scope and all
scheduled attempts. Comparative source inventories and supplied historical CI
counts do not establish installed behavior or comparative task reliability.
