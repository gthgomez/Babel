<!--
status: ACTIVE
last_verified: 2026-08-03
architecture_version: harness-v1
-->

# Golden Harness Contract Fixture

> **Name**: Canonical episode **conformance example** (not an end-to-end production harness demonstration).  
> **Purpose**: Deterministic, model-free illustration of Babel’s **harness-v1** completion + mode + evidence *contracts*.  
> **Normative authority**: [`docs/architecture/HARNESS_ARCHITECTURE_V1.md`](../../docs/architecture/HARNESS_ARCHITECTURE_V1.md)  
> **Executable checks**: `babel-cli/src/executor/architectureConformance.test.ts` loads fixtures from this directory.

## What this is (and is not)

This is a **golden harness contract fixture** / **canonical episode conformance example**.

It is **not**:

- an end-to-end golden proof of the full controller loop,
- a complete executable production demonstration,
- proof that ChatEngine/pipeline naturally emit the full event sequence.

It **does** freeze expected semantics before all runtime wiring exists, and exercises live kernel/honesty slices where noted.

| Portion | Live runtime? | Notes |
|---------|---------------|--------|
| Mode policies, kernel completion decide, effect classification, structured verifier parse | **Live** (conformance tests import `babel-cli` modules) | No external model |
| Episode event sequence, task contract, patch/revision artifacts | **Simulated fixtures** | Represent target episode shape; not produced by a live controller run |
| Stale-receipt honesty (`stale: true` flag) | **Live** gate reaction to pre-marked flag | **Not** revision-bound auto-detection |
| Narrow-vs-broad verifier coverage | **Target audit fixture** | Current pipeline identity may be lossy |
| Isolation fail-closed | **Target audit fixture** | Current code may host-fallback |

## Positive golden scenario

Concept sequence (see `fixture/expected-events.jsonl`):

```text
TASK_CONTRACT_FROZEN
BASELINE_VERIFIER_FAILED
PLAN_ACCEPTED
MUTATION_STARTED
FILE_MUTATED
VERIFIER_FAILED
FAILURE_CLASSIFIED
REPAIR_STARTED
FILE_MUTATED
VERIFIER_PASSED
WORKSPACE_REVISION_CAPTURED
COMPLETION_PROPOSED
COMPLETION_ACCEPTED
VERIFIED_COMPLETE
```

Fixture project (`fixture/project/`):

- Bug in `src/add.ts` (initially returns wrong sum)
- Authoritative test `tests/add.test.ts`
- Protected verifier surface: `package.json` scripts + test file (agent MUST NOT treat ad-hoc `_verify*.py` as authority)

## Negative cases (`negative/`)

| Fixture | Expectation | Live today? |
|---------|-------------|-------------|
| `plan-mutation-denied.json` | Plan requests mutation → denied; plan success = `PLAN_COMPLETE` only | **Yes** (kernel + mode policy) |
| `stale-verifier-receipt.json` | Green receipt with `stale: true` → honesty reject | **IMPLEMENTED**: gate rejects flag. **TARGET**: derive staleness from `boundRevision` vs workspace |
| `narrow-verifier-vs-broad-required.json` | Full suite required; targeted-only run MUST NOT satisfy | **Target** (audit) |
| `isolation-unavailable.json` | Governed isolation required + backend missing → block/escalate, not silent host | **Target** (audit) |

## How engineers use this

1. Read `HARNESS_ARCHITECTURE_V1.md` invariants.  
2. Run `npx tsx --test src/executor/architectureConformance.test.ts` from `babel-cli/`.  
3. Run `pwsh tools/check-harness-architecture.ps1` from repo root.  
4. When changing completion or mode policy, update fixtures **in the same change set**.

Do not point live product claims at simulated events without labeling them simulated.
