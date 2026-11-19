# REBASE_W02_DELTAS — W01 after W02 (#544)

Owner: W01 (#522). Repo root file so the rebase obligation travels with the branch.
Status at W01 head before rebase: the current kernel ignores `finalRevisionRequired`, so the
ambient control is a forward pin, not proof against W02.

## 1. Exact post-merge change

After W02 #544 merges and this branch is rebased:

- `babel-cli/src/agent/chatEngine.ts`, `ChatEngine.decideCompletion` (the
  `this.executorKernel.completion.decide({...})` call, currently ~2713-2736):
  - Replace the local forward projection with W02's real producer/helper from
    `babel-cli/src/authority/finalRevision.ts`:
    `finalRevisionRequired = chatFinalRevisionRequired({ ambientReadOnly: isReadOnlyChat(), hasProjectRoot: Boolean(this.options.projectRoot) })`.
    Keep `finalRevisionRequired: false` only when that helper returns false
    (ambient read-only, or no project root).
  - For the project-scoped accepted no-change path (`isAcceptedReadOnlyTerminal()` true,
    `chatFinalRevisionRequired(...)` true), pass W02's `FinalRevisionWitnessV1`
    `finalRevision` produced by `evaluateFinalRevisionWitness({ projectRoot,
    toolCallLog: toGateToolLog(this.toolCallLog), requiredVerifierCommands:
    verifierInput.requiredVerifierCommands })`. If no witness can be produced, pass
    `unavailableFinalRevisionWitness(reason)` (this correctly downgrades); never
    fabricate a `verified` witness.
  - Mutating/VERIFIED paths keep their existing fields; no final-revision option.
- `ChatEngine.buildResult` readOnly projection (~4640) calls the same predicate; it emits
  `NO_CHANGE_REQUIRED` through `decideCompletion`, so it inherits the same scoping.
  `chatEngineTerminalRuntime` has no `decide()` call and needs no delta.
- Do not change `kernel.ts` or the receipt/contract schema in W01.

Which W01 path is which:

| W01 terminal path | Ambient? | W02 projection |
|---|---|---|
| explicit ambient read-only chat | `isReadOnlyChat() === true` | `finalRevisionRequired: false` |
| project-scoped accepted inspection-only no-change | false | witness required (pass `finalRevision`) |
| mutation / VERIFIED_COMPLETE | false | not a no-change proof; unchanged |

## 2. Rebase-time test to add (both directions)

Add a W01 test that drives the same `decide()` call shape:

1. **Positive (project-scoped):** build a project-scoped `NO_CHANGE_REQUIRED` decision with a
   current receipt/workspace witness and W02's `finalRevision` field. Assert
   `allowed === true` and `finalOutcome === 'NO_CHANGE_REQUIRED'`.
2. **Negative (missing witness):** remove/blank the same witness while keeping
   `finalRevisionRequired` unset or true. Assert `finalOutcome === 'UNVERIFIED_PATCH'`.

The existing forward pin is
`P1 sequencing: ambient NO_CHANGE opts out of final-revision proof explicitly`
(`src/agent/taskAcceptanceEvidenceCompletion.test.ts`). It asserts the ambient helper and
passes the spread through `createExecutorKernel('chat').completion.decide`; it fails if
W02's kernel ignores or rejects the ambient opt-out.

Use W02's exported helpers directly in the rebase-time test:
`chatFinalRevisionRequired`, `evaluateFinalRevisionWitness`,
`unavailableFinalRevisionWitness`, and the `FinalRevisionWitnessV1` type, all from
`src/authority/finalRevision.ts`. Do not hand-build witness objects.

## 3. Ambient control after rebase

`noChangeFinalRevisionScope({ ambientReadOnly: true })` must remain
`{ finalRevisionRequired: false }`. This is not a claim that ambient no-change is
unproofed: it is the explicit W02 opt-out for a request with no project-scoped final
revision. Project-scoped no-change must never use it.
