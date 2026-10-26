# P2 production FILE / FUNCTION proposal (root review — not implemented)

Narrow hooks only. No new control framework or giant test file.

## 1. Broker-origin denial fact (record at actual boundary)

| Item | Detail |
|------|--------|
| **File** | `babel-cli/src/agent/chatEngineActionExecutor.ts` (existing shell gate path ~prerequisite suppression / broker block) |
| **Function** | Private helper adjacent to existing `prerequisite_suppressed` branch, e.g. `recordIsolationShellBrokerDenialFact(...)` |
| **When** | First governed broker evaluation for a shell tool when stderr contains `[CAPABILITY_DENIED:isolation_unavailable]` and `error: blocked` (today’s settlement) |
| **Fields** | `prerequisiteKey` (`isolation_unavailable:shell`), `taskOwnerId`, `environmentIdentity`, `revisionKey` (from `bindIsolationPrerequisiteScope`), `requiredVerifierCommands` snapshot (from host `getResolvedRequiredVerifiers()`), `commandIdentity` (normalized shell target string), `brokerMarker` (constant), `recordedAtMs` |
| **Storage** | Append-once per `(taskOwnerId, revisionKey, prerequisiteKey)` on `ProgressController` task-local set (new field parallel to `consumedPrerequisiteDenials`, not replacing probe keys) |
| **Reset / ownership** | Same rules as `admitPrerequisiteDenialProbe`: survives `resetTaskLocal` on same owner; new `taskOwnerId` or `revisionKey` or `environmentIdentity` → new slot; never read from model output |

## 2. Scope revalidation before using the fact

| Item | Detail |
|------|--------|
| **File** | `babel-cli/src/agent/capabilityRecoveryScope.ts` |
| **Function** | `revalidateIsolationPrerequisiteScope(host, priorFact): boolean` |
| **Checks** | Recompute `bindIsolationPrerequisiteScope(host)`; require byte-equal `taskId`, `environmentIdentity`, `revisionKey`, `prerequisiteKey` vs fact; call `shellBlockedByIsolation(host.isolationBrokerFlags())` still true |
| **On failure** | Treat fact as stale; keep `reject_continue` recovery (no completion credit) |

## 3. Explicit required-verifier predicate (no shell-scope-only credit)

| Item | Detail |
|------|--------|
| **File** | `babel-cli/src/agent/completionGatePolicy.ts` (or thin wrapper `requiredVerifierFactPredicate.ts` colocated) |
| **Function** | `requiredVerifierStillMissingForFact(fact, verifierInput): { missing: true, reason: 'verifier_missing' } \| { missing: false }` |
| **Logic** | `satisfiesVerifierRequirement` each `fact.requiredVerifierCommands[]` against `executedVerifierLedger` / `lastVerifierReceipt`; unrelated blocked shell receipts do not satisfy npm obligation |
| **Reset** | Predicate is pure; no mutable state |

## 4. Existing blocked settlement + useful-candidate presentation

| Item | Detail |
|------|--------|
| **Settlement (unchanged)** | `toolExecutor` / action executor: `error: blocked`, `detail: prerequisite_suppressed` on repeat; `ProgressController.admitPrerequisiteDenialProbe` one evaluation per revision |
| **File** | `babel-cli/src/agent/chatEngine.ts` or planner module that already emits blocked-path candidates |
| **Function** | Extend existing blocked planner / candidate presentation only: attach **read-only** fact summary to useful candidate metadata (command identity + revision), not a new completion authority |
| **Rule** | Fact may inform presentation; **completion honesty** still uses `evaluateExecuteCompletionHonesty` + authoritative gate — fact does not bypass guard |

## 5. dev_local budget-before-transport

Separate fixture/default issue (`OpenCodeGoBudget.reserve` before mocked `fetch`). **Not** permission to remove canonical guard or skip §1–4 when scope unknown.
