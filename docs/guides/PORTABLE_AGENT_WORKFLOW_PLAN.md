<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
-->

```yaml
status: IMPLEMENTED_PHASE_0
authority: non-normative
depends_on: harness-v1
last_verified: 2026-08-08
```

# Portable Agent Workflow Plan

> This document refines the portable workflow direction. It is a planning
> contract, not a second runtime specification. The native Babel harness and
> [HARNESS_ARCHITECTURE_V1.md](../architecture/HARNESS_ARCHITECTURE_V1.md)
> remain authoritative.

## 1. Boundary

The portable layer describes workflow meaning. Babel performs the actual
execution.

```text
portable semantics → native Babel controller → native tools and evidence
```

The portable layer MUST NOT:

- execute tools directly;
- decide whether a verifier receipt is authoritative;
- create a second task, budget, revision, or completion authority;
- treat a model's completion claim as a terminal outcome; or
- import private provider credentials or machine paths into an export.

Portable records are projections or requests. Native records remain the source
of truth and are referenced by stable IDs and hashes.

## 2. Closed v1 schema graph

Phase 0 is complete only when these types are defined, versioned, serializable,
and covered by round-trip and invalid-state tests. The names below are the full
v1 graph; no placeholder type is allowed in the frozen contract.

### 2.1 Shared value types

```ts
type Version = 'portable-workflow-v1'
type Id = string
type Sha256 = string

type RevisionRefV1 = {
  kind: 'workspace-revision'
  composite_tree_hash: Sha256
  source: 'git' | 'filesystem' | 'native-authority'
}

type EvidenceRefV1 = {
  id: Id
  kind: 'event' | 'artifact' | 'verifier-receipt' | 'checkpoint'
  sha256: Sha256
  native_path?: string
}

type AuthorityRefV1 = {
  native_kind: 'task-contract' | 'instruction-manifest' | 'live-session' | 'episode'
  native_id: Id
  sha256: Sha256
}

type VerifierIdentityV1 = {
  command: string
  command_sha256: Sha256
  scope: string[]
  independent: boolean
  clean_room: boolean
}

type VerifierReceiptV1 = {
  id: Id
  status: 'passed' | 'failed' | 'blocked'
  verifier: VerifierIdentityV1
  bound_revision: RevisionRefV1
  authority: AuthorityRefV1
  evidence: EvidenceRefV1[]
  exit_code?: number
  produced_at: string
}
```

`native_path` is optional and MUST be redacted from untrusted exports unless
the export policy explicitly permits it. A portable receipt is never stronger
than the native receipt from which it was projected.

### 2.2 Workflow records

```ts
type WorkflowRunV1 = {
  version: Version
  run_id: Id
  task: TaskRefV1
  authority: AuthorityRefV1
  stages: StageRecordV1[]
  workers: WorkerRunV1[]
  terminal?: TerminalOutcomeV1
  revision?: RevisionRefV1
  evidence: EvidenceRefV1[]
}

type TaskRefV1 = {
  task_id: Id
  goal: string
  acceptance_criteria: string[]
  mutation_policy: 'read_only' | 'workspace_write' | 'governed'
  required_verifiers: string[]
}

type StageRecordV1 = {
  stage_id: Id
  kind: 'orient' | 'review' | 'attack' | 'integrate'
  status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled'
  input: StageInputV1
  result?: StageResultV1
  workers: Id[]
  evidence: EvidenceRefV1[]
}

type WorkerRunV1 = {
  worker_id: Id
  stage_id: Id
  role: 'primary' | 'reviewer' | 'verifier' | 'integrator'
  status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled'
  provider?: string
  native_authority: AuthorityRefV1
  evidence: EvidenceRefV1[]
}

type StageInputV1 =
  | { kind: 'orient'; task: TaskRefV1 }
  | { kind: 'review'; task: TaskRefV1; target_refs: EvidenceRefV1[] }
  | { kind: 'attack'; task: TaskRefV1; target_refs: EvidenceRefV1[] }
  | { kind: 'integrate'; task: TaskRefV1; stage_refs: Id[] }

type StageResultV1 =
  | { kind: 'orient'; findings: string[] }
  | { kind: 'review'; findings: string[]; required_changes: string[] }
  | { kind: 'attack'; findings: string[]; reproductions: EvidenceRefV1[] }
  | { kind: 'integrate'; verifier_receipts: VerifierReceiptV1[]; changed_refs: EvidenceRefV1[] }
```

### 2.3 Terminal and repair records

```ts
type TerminalOutcomeV1 =
  | { kind: 'completed_verified'; receipts: Id[]; revision: RevisionRefV1 }
  | { kind: 'completed_unverified'; reason: string }
  | { kind: 'blocked_external'; reason: string }
  | { kind: 'blocked_policy'; reason: string }
  | { kind: 'budget_exhausted'; dimension: 'turns' | 'tokens' | 'repair' | 'infra' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'infra_failure'; reason: string }
  | { kind: 'agent_failure'; reason: string }

type FailureClassV1 =
  | 'task' | 'context' | 'implementation' | 'verifier'
  | 'infrastructure' | 'policy' | 'provider' | 'budget'

type RepairTransitionV1 = {
  from: 'failed' | 'blocked'
  to: 'pending' | 'running'
  class: FailureClassV1
  reason: string
  invalidates_receipts: boolean
  evidence: EvidenceRefV1[]
}

type GoalAmendmentV1 = {
  amendment_id: Id
  previous_task_id: Id
  new_task: TaskRefV1
  approved_by: 'user' | 'controller'
  invalidates_receipts: boolean
}

type PortableExportV1 = {
  version: Version
  run: WorkflowRunV1
  redaction_profile: 'public' | 'internal' | 'diagnostic'
  exported_at: string
}
```

## 3. Authority and projection map

| Portable concern | Native Babel authority | Direction | Lossless? |
|---|---|---|---|
| Task and acceptance | `TaskContractV1` / task envelope | native → portable | No; portable text is a projection |
| Instruction context | instruction manifest | native → portable | No; hash and provenance are preserved |
| Stage/worker lifecycle | session and episode events | native ↔ portable adapter | Only with event IDs and sequence |
| Tool identity | native tool call + idempotency key | native → portable | Yes for identity |
| Budget state | live session budget snapshot | native → portable | Yes for recorded dimensions |
| Workspace revision | native revision capture | native → portable | Yes for the hash |
| Verification | native verifier receipt | native → portable | Receipt authority must be preserved |
| Terminal outcome | native completion kernel | native → portable | Meaning must not be broadened |
| Evidence | native event/artifact store | native → portable | References and hashes are preserved |

Adapters MUST fail closed when a required native authority record is missing,
corrupt, stale, or ambiguous. They MUST NOT synthesize a stronger portable
state from a weaker native projection.

## 4. State and repair rules

The portable workflow may request these transitions:

```text
pending → running → passed
                   ├→ failed → pending (repair)
                   ├→ blocked → pending (repair)
                   └→ cancelled
```

The following combinations are invalid and MUST be rejected:

- `completed_verified` without at least one authoritative passed receipt;
- a passed receipt whose bound revision differs from the current native revision;
- a repair transition that keeps receipts marked valid after a relevant mutation;
- an `integrate` stage before its referenced stages are terminal;
- a worker referencing a different stage than its parent record;
- a stage marked `passed` without a result and evidence;
- a goal amendment that retains receipts from the superseded task; or
- a run marked terminal while any required stage or verifier is unresolved.

Crash recovery uses native checkpoint journals and event sequence numbers. A
portable importer may replay a committed native generation, but it must not
guess whether an in-progress generation committed. Ambiguous recovery returns
`blocked_external` or `infra_failure` with the recovery evidence attached.

Retries use the native operation idempotency key. A started non-idempotent
operation without a terminal event is interrupted, not automatically replayed.

## 5. Verification strength

Portable evidence requested by a stage is not automatically strong enough to
authorize verified completion.

| Proof profile | May support verified completion? | Requirement |
|---|---:|---|
| authoritative test/verifier | Yes | Native receipt, scope, command identity, and revision match |
| clean-room verifier | Yes | Independent environment and native receipt are recorded |
| inspection | Only when policy allows | Required criterion explicitly permits inspection proof |
| model assertion | No | Proposal only |
| missing or ambiguous evidence | No | Run remains blocked or unverified |

Security-critical criteria MUST require an authoritative verifier or an
explicitly approved clean-room receipt. Cross-harness comparisons MUST keep
model, environment, permission, provider, and verifier factors separate so a
portable score cannot be mistaken for harness lift.

## 6. Export and redaction policy

`public` exports may contain task prose, stage summaries, outcome labels,
content hashes, stable native IDs, and redacted evidence metadata. They MUST
remove credentials, authorization headers, environment values, absolute
machine paths, private repository URLs, raw provider payloads, and unredacted
command output that contains secrets.

`internal` exports may include operator-approved paths and diagnostic metadata.
`diagnostic` exports are local-only and MUST NOT be committed or uploaded by
the portable workflow.

Every export records its schema version and redaction profile. Importers reject
unknown versions, unknown enum values, missing required hashes, and public
exports containing denied fields.

## 7. Phase 0 implementation order

1. Add the closed schema graph and discriminated-union validation.
2. Add native-to-portable adapters for task, stages, workers, receipts,
   evidence, revision, and terminal outcomes.
3. Add round-trip, invalid-transition, repair, amendment, and canonical export
   fixtures.
4. Add redaction tests and reject-on-unknown-field/version behavior.
5. Add crash/recovery fixtures using the native checkpoint journal.
6. Run the portable contract suite against native golden episodes.

Phase 0 is not ready for coding if any type above remains undefined, any
adapter creates a second authority, or a portable terminal can be stronger
than its native evidence.

## 8. Exit gates before runtime implementation

- The schema graph compiles with no unresolved references.
- Every record has an explicit version and stable identity.
- Valid records round-trip without semantic loss.
- Invalid state combinations are rejected deterministically.
- Native-to-portable mappings preserve authority, scope, revision, and evidence.
- Repairs and goal amendments invalidate affected receipts.
- Crash recovery is delegated to native checkpoint semantics.
- Public export fixtures demonstrate redaction of secrets and machine-specific data.
- The guide remains subordinate to `harness-v1` and does not authorize a second
  executor.

The narrow adapter implementation below is limited to projection and validation;
it does not create a second executor or authority.

## 9. Phase 0 implementation

The Phase 0 contract implementation lives in
`babel-cli/src/portable/workflow.ts` and is re-exported from
`babel-cli/src/portable/index.ts`. It provides strict schemas, native
authority/revision/verifier projections, invalid-state checks, committed-only
checkpoint recovery, and public export redaction. The focused contract suite
is run with:

```text
npm run test:portable-workflow
```

The module remains a projection layer: native task contracts, instruction
manifests, live-session authorities, verifier receipts, and checkpoint journals
remain authoritative.
