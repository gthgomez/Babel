# Autonomous SWE PR #117 reconciliation

<!-- status: completed against origin/main 09882fa839253e9615a1e95ec6cd4fe81edb7871 -->

PR #117 (`020f7a502be9f134aad9103d7307a2739d1e2684`) was an older parallel
V1.1 attempt. It was not merged as-is. The following semantic reconciliation
compares its meaningful changes with current main (PR #118 authority closure
and PR #119 merge-control hardening) and the PR-B implementation.

| feature/change | classification | current-main equivalent | action taken | evidence |
|---|---|---|---|---|
| Supervisor-issued execution identity and execution context | PARTIALLY_SUPERSEDED | Main had trusted execution descriptors and task/run/contract checks, but direct registry construction remained possible and context was not durable | Retained the current evidence-layer API; added supervisor-only construction, authoritative read-port identity, task/run/contract bindings, lifecycle, and durable reload checks | `babel-cli/src/evidence/trustedExecutionIdentity.ts`; PR #117 `babel-cli/src/authority/trustedExecution.ts` |
| Authority grants and capability narrowing | PARTIALLY_SUPERSEDED | Main reused capability IDs but did not persist assignment lifecycle or reject every widened reload | Kept current capability vocabulary and added assignment capability validation, lifecycle transitions, and fail-closed persisted state | `trustedExecutionIdentity.ts`; PR #117 authority grant code |
| Builder identity impersonation prevention | STILL_VALUABLE | Main checked descriptive role/endpoint fields but the caller could supply a fabricated branded-looking registry port | Added module-private authoritative branding and a singleton authoritative read port; factory-created local ports are not completion authority | `isTrustedExecutionReadPort`; hardening test |
| Frozen verifier/review receipt shape | PARTIALLY_SUPERSEDED | Main had V1 revision receipts and self-hashed review-shaped data | Retained revision receipt compatibility while adding explicit scope; replaced accepted review shape with challenge-bound signed V2 receipts | `revisionBoundReceipt.ts`, `independentReview.ts`, `verify-independent-review.mjs` |
| Revision receipt validation | PARTIALLY_SUPERSEDED | Main validated hashes but permitted nullable Git and empty file scope | Added files/repository scope distinction, path safety, exact file-hash matching, explicit Git mode, composite-hash checks, and stale detection | `revisionBoundReceipt.ts`; hardening test |
| Durable secret protection and redaction | ALREADY_SUPERSEDED | Main already contained the stronger #118/#119 redaction and public-scrub controls | Did not cherry-pick the parallel implementation; preserved current controls and applied only new hardening where needed | current-main redaction/public policy files; PR #117 diff |
| Task event journal hardening | PARTIALLY_SUPERSEDED | Main had a hash-linked JSONL journal and atomic replacement | Added run/contract binding and fsync-before-rename; retained append-only sequence/hash validation | `taskEventJournal.ts` |
| Breaker contract and focused coverage | PARTIALLY_SUPERSEDED | Main had a read-only Breaker contract but no executable lane | Added executable read-only lane, structured report, UNKNOWN on execution failure, and hardening coverage | `breakerContract.ts`; hardening test |
| Evidence graph and lifecycle semantics | PARTIALLY_SUPERSEDED | Main had typed graph validation and completion states | Added graph sealing, authoritative execution checks, verifier executable identity, Breaker blockers, and explicit lifecycle state machine | `evidenceGraph.ts`, `executionLifecycle.ts` |
| Focused Autonomous SWE CI coverage | ALREADY_SUPERSEDED | Current main already carried focused typecheck/test lanes from #118/#119 | Extended local adversarial coverage; did not duplicate the existing workflow structure | `.github/workflows/typecheck.yml`; PR #117 diff |
| Merge-gate pagination and ordering | PARTIALLY_SUPERSEDED | #119 fixed deterministic resolution but review-thread pagination was still limited to 100 and IDs needed numeric ordering | Added fail-closed review-thread pagination, numeric run/check ordering, and adversarial fixtures | `agent-pr-gate.ps1`, `agent-pr-gate-common.psm1`, `tools/tests/test-agent-pr-gate.ps1` |
| PR #117 documentation | OBSOLETE | Its statements described a parallel V1.1 architecture and old receipt semantics | Replaced applicable claims with PR-B truth and recorded this reconciliation | `AUTONOMOUS_SWE_FOUNDATIONS_V1.md`, this document |
| Old `authority/trustedExecution.ts` registry implementation | CONFLICTS_WITH_CURRENT_ARCHITECTURE | Current main’s canonical seam is `evidence/trustedExecutionIdentity.ts` | Not ported as a second registry; only its authoritative-host design was re-expressed in the current seam | PR #117 file versus current-main imports |

No PR #117 code was merged wholesale. Its unique valuable ideas were either
ported into the current seam or explicitly rejected above. Closure of PR #117
is authorized only after this document is present on the PR-B branch and the
new implementation has been independently inspected.
