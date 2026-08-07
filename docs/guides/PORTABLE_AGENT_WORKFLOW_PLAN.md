<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

```yaml
status: DRAFT_GUIDE
kind: implementation-roadmap
normative: false
last_verified: 2026-08-07
scope: portable-agent-workflow
```

# Portable Agent Workflow Plan

## 1. Executive summary

Babel should implement a **portable engineering workflow protocol** that can run independently in multiple agent harnesses.

The workflow is not “Codex controlling Babel,” and it is not “Babel controlling Codex.” Instead:

```text
                         ┌─────────────────────────────┐
                         │ Portable Workflow Contract  │
                         │ goal / roles / gates /      │
                         │ evidence / completion       │
                         └──────────────┬──────────────┘
                                        │
                     ┌──────────────────┴──────────────────┐
                     │                                     │
                     ▼                                     ▼
          ┌──────────────────────┐              ┌──────────────────────┐
          │ Babel Native Runtime │              │ Codex Native Runtime │
          │                      │              │                      │
          │ Babel controllers    │              │ Codex goal/task      │
          │ agent teams          │              │ Codex agents         │
          │ worktree isolation   │              │ worktree isolation   │
          │ verifier kernel      │              │ native verification  │
          │ evidence/replay      │              │ native task evidence │
          └──────────────────────┘              └──────────────────────┘
```

Both runtimes should be able to execute the **same logical workflow** without depending on the other.

The portable layer defines the semantics of a trustworthy software-engineering run:

```text
Goal
→ Orient
→ Plan
→ Decompose
→ Implement
→ Review
→ Attack
→ Verify
→ Integrate
→ Release Gate
→ Evidence-backed Completion
```

Babel already contains many of the necessary primitives. The highest-value work is therefore to **unify them behind one explicit workflow contract**, make the stages observable and replayable, and provide adapters that map the portable contract onto each supported harness.

This document is an implementation roadmap, not a replacement for Babel's normative harness architecture. `docs/architecture/HARNESS_ARCHITECTURE_V1.md` remains authoritative for runtime harness invariants.

---

# 2. Product objective

The target product capability is:

> A user can define one bounded engineering goal and run the same evidence-first workflow in Babel or another compatible coding-agent harness, while each harness executes the workflow using its own native agent/runtime capabilities.

Example:

```text
Goal:
"Refactor the provider retry layer without changing public behavior,
add regression coverage for timeout and malformed-response paths,
and prove the change through the required verifier suite."
```

The user should be able to run that goal through:

```text
Babel
```

or independently through:

```text
Codex
```

and receive conceptually equivalent artifacts:

- frozen goal contract;
- repository orientation report;
- implementation plan;
- worker assignments;
- isolated patches;
- reviewer findings;
- adversarial findings;
- verifier receipts;
- integration decision;
- final evidence report;
- release readiness state.

The implementations do **not** need identical internal APIs. They need equivalent workflow semantics and comparable output evidence.

---

# 3. Core principle: portable semantics, native execution

The portability boundary should sit above individual harness implementation details.

## Portable

These concepts should mean the same thing everywhere:

- Goal Contract
- stage identity
- role identity
- scope boundaries
- write authority
- success criteria
- stop conditions
- verification requirements
- evidence schema
- terminal outcome semantics
- reviewer/adversary separation
- integration authority
- release gate semantics

## Runtime-specific

These details belong to each harness adapter:

- how subagents are launched;
- how a worktree is created;
- how tool permissions are represented;
- how model selection works;
- how context is loaded;
- how terminal/UI automation works;
- how commands are scheduled;
- how conversation history is represented;
- how the runtime exposes progress to users.

Therefore:

```text
Portable Workflow != shared runtime implementation
```

Instead:

```text
Portable Workflow = shared behavioral contract
Runtime Adapter = harness-specific realization of that contract
```

---

# 4. Why Babel is already close

Babel already contains substantial machinery that maps directly onto this design.

Existing repository capabilities include:

- `AgentTeamSpec` with multiple agents;
- declared `allowed_tools` and `disallowed_tools`;
- declared `write_scope`;
- `review_only` agents;
- rejection of overlapping writable scopes;
- `git_worktree` isolation;
- per-agent evidence;
- evidence-required merge policy;
- rollback/restore plans;
- live subagents;
- lead synthesis;
- agent jobs;
- job priorities and retries;
- verification command lists;
- approval state;
- completion verification;
- model escalation;
- workspace safety;
- executor-owned completion authority;
- evidence and episode streams;
- required verifier contracts;
- public release gates.

The portable-workflow project should therefore avoid creating a second orchestration stack.

The preferred strategy is:

```text
existing Babel primitives
        ↓
small common workflow types
        ↓
workflow controller
        ↓
stage adapters into existing services
```

---

# 5. Non-goals

The first version should not attempt to:

- create a universal standard for every AI agent product;
- force Codex and Babel to have identical prompts;
- replace Babel's three controller modes;
- replace `AgentTeamSpec`;
- replace the verifier kernel;
- replace the existing evidence system;
- automatically merge PRs;
- automatically deploy production systems;
- support arbitrary workflow graphs;
- create a visual workflow builder;
- require cloud infrastructure;
- create distributed multi-machine execution;
- permit an implementer to self-certify completion;
- optimize for maximum number of subagents.

The first version should be deliberately opinionated and linear.

---

# 6. Portable workflow v1

The recommended workflow is:

```text
P0 CONTRACT
P1 ORIENT
P2 PLAN
P3 DECOMPOSE
P4 IMPLEMENT
P5 REVIEW
P6 ATTACK
P7 VERIFY
P8 INTEGRATE
P9 RELEASE_GATE
P10 COMPLETE
```

Not every task requires every stage to perform substantial work, but every run should record whether each stage was:

```text
executed
skipped_with_reason
failed
blocked
```

This gives the system a stable episode shape.

---

# 7. P0 — Goal Contract

The workflow begins by freezing an explicit goal contract.

## GoalContractV1

Recommended logical schema:

```ts
interface GoalContractV1 {
  schema_version: 1;
  goal_id: string;

  objective: string;
  motivation?: string;

  scope: {
    include: string[];
    exclude: string[];
  };

  invariants: string[];
  success_criteria: SuccessCriterion[];
  required_verifiers: RequiredVerifier[];

  permissions: {
    mutation: 'none' | 'workspace' | 'bounded';
    network: 'none' | 'docs_only' | 'bounded';
    git_publish: 'none' | 'draft_pr';
  };

  forbidden_actions: string[];
  stop_conditions: string[];

  budgets?: {
    max_iterations?: number;
    max_agents?: number;
    max_wall_time_seconds?: number;
    max_cost_units?: number;
  };
}
```

## SuccessCriterion

```ts
interface SuccessCriterion {
  id: string;
  description: string;
  proof_type:
    | 'test'
    | 'build'
    | 'typecheck'
    | 'benchmark'
    | 'static_analysis'
    | 'ui_scenario'
    | 'inspection'
    | 'other';
}
```

## RequiredVerifier

```ts
interface RequiredVerifier {
  id: string;
  criterion_ids: string[];
  command?: string;
  verifier_type: string;
  required: boolean;
}
```

## Invariant

The Goal Contract is frozen before mutation begins.

The runtime may append discoveries and clarifications as evidence, but should not silently rewrite the original objective to make completion easier.

---

# 8. P1 — Orient

Orientation answers:

> What does the repository currently say is true?

Before implementation, the runtime should discover:

- repository authority files;
- project architecture;
- affected subsystem;
- relevant contracts;
- relevant tests;
- known high-risk zones;
- current Git/worktree state;
- likely regression surfaces;
- existing implementation that may already solve part of the goal.

## Babel implementation

For Babel itself, the orientation stage should follow existing authority, including the relevant startup files and the normative harness document when harness work is involved.

## Output

```ts
interface OrientationReportV1 {
  authoritative_sources: string[];
  affected_paths: string[];
  affected_contracts: string[];
  existing_verifiers: string[];
  risk_zones: string[];
  open_questions: string[];
}
```

## Gate

Mutation cannot begin if orientation discovers a material conflict between the Goal Contract and repository authority.

---

# 9. P2 — Plan

The planning stage produces an implementation hypothesis, not a final commitment.

The plan should identify:

- desired behavior;
- minimal affected surfaces;
- implementation sequence;
- verification sequence;
- expected failure modes;
- potential rollback path;
- whether subagent decomposition is useful.

## Plan principles

Prefer:

```text
small semantic slices
```

rather than:

```text
large file-count partitions
```

The plan should explain why each proposed change is necessary.

---

# 10. P3 — Decompose

The runtime chooses a team topology.

## Default topology

For ordinary non-trivial engineering work:

```text
Manager
Implementer
Verifier
```

Add roles only when justified.

Possible expanded topology:

```text
Manager
├── Repository Mapper
├── Implementer A
├── Implementer B
├── Diff Reviewer
├── Adversarial Reviewer
└── Independent Verifier
```

## AgentRoleV1

```ts
type AgentRoleV1 =
  | 'manager'
  | 'mapper'
  | 'implementer'
  | 'reviewer'
  | 'adversary'
  | 'verifier'
  | 'ui_qa';
```

## WorkerAssignmentV1

```ts
interface WorkerAssignmentV1 {
  worker_id: string;
  role: AgentRoleV1;
  task: string;

  read_scope: string[];
  write_scope: string[];

  allowed_capabilities: string[];
  disallowed_capabilities: string[];

  expected_artifacts: string[];
}
```

## Babel mapping

This should map naturally onto the existing `AgentTeamSpec` / subagent schema instead of replacing it.

For example:

```text
WorkerAssignment.write_scope
→ SubagentSpec.write_scope

WorkerAssignment.role = reviewer
→ merge_strategy = review_only

parallel mutable workers
→ isolation = git_worktree
```

---

# 11. P4 — Implement

Implementers work inside explicit scope.

Rules:

1. No implicit scope expansion.
2. Tests should travel with behavior changes.
3. Shared public contracts require explicit plan awareness.
4. Generated output should not be hand-edited when source exists.
5. Unexpected repository state is reported rather than overwritten.
6. Each implementer returns revision-linked evidence.

## Implementer result

```ts
interface ImplementationResultV1 {
  worker_id: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
  changed_files: string[];
  verification_attempts: VerificationReceiptV1[];
  discoveries: string[];
  unresolved_risks: string[];
}
```

---

# 12. P5 — Review

The reviewer is logically independent from the implementer.

The review stage checks:

- scope adherence;
- architecture consistency;
- unnecessary complexity;
- missing call sites;
- incorrect assumptions;
- public contract regressions;
- missing tests;
- stale comments/docs;
- duplicate logic;
- accidental safety weakening;
- cross-platform assumptions.

## Reviewer rule

The reviewer should be instructed to **falsify the implementation**, not summarize it.

## ReviewFindingV1

```ts
interface ReviewFindingV1 {
  id: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'blocker';
  category: string;
  claim: string;
  evidence: string[];
  disposition: 'open' | 'accepted' | 'rejected' | 'fixed';
}
```

---

# 13. P6 — Attack

Review asks "is this good?"

Attack asks:

> How can this fail?

The adversarial stage generates concrete counterexamples.

For Babel, high-value attack classes include:

- false completion;
- stale evidence;
- malformed tool results;
- timeout;
- cancellation;
- retry loops;
- interrupted mutation;
- dirty workspace;
- permission escalation;
- write-scope escape;
- path traversal;
- cross-platform path behavior;
- process failure;
- partial persistence;
- concurrent worker conflict;
- verifier infrastructure failure.

## Attack output

```ts
interface AttackScenarioV1 {
  id: string;
  hypothesis: string;
  reproduction: string[];
  expected_safe_behavior: string;
  observed_behavior?: string;
  result: 'pass' | 'fail' | 'blocked';
}
```

Any discovered real defect should ideally become a durable regression test or fixture.

---

# 14. P7 — Verify

Verification is owned outside the implementer's self-report.

Verification priority:

```text
1. deterministic test
2. independent verifier
3. static/type/build oracle
4. golden/replay fixture
5. property/fuzz test
6. benchmark threshold
7. UI/computer-use scenario
8. structured inspection
```

## VerificationReceiptV1

```ts
interface VerificationReceiptV1 {
  verifier_id: string;
  criterion_ids: string[];

  workspace_revision: string;
  started_at: string;
  completed_at: string;

  result: 'pass' | 'fail' | 'blocked' | 'infra_error';

  command?: string;
  exit_code?: number;
  evidence_paths: string[];
  summary: string;
}
```

## Critical invariant

A verification receipt proves only the workspace revision it was run against.

If the workspace changes afterward, the runtime must mark affected receipts stale.

This aligns with Babel's existing revision-binding direction and independent completion authority.

---

# 15. P8 — Integrate

Integration is manager-owned.

The manager decides which worker patches are eligible for the final workspace.

## Integration prerequisites

An implementation slice is not integration-ready unless:

- worker evidence exists;
- write scope was respected;
- required review findings are resolved;
- required adversarial scenarios pass or are explicitly dispositioned;
- required verification is current;
- dependencies between slices are understood.

## Babel mapping

The existing agent-team merge system already provides valuable foundations:

- evidence-required merges;
- disjoint-scope auto merge rules;
- conflict diagnostics;
- restore snapshots.

The portable workflow controller should consume those capabilities rather than duplicate them.

---

# 16. P9 — Release Gate

The portable workflow's release gate means:

> Is this integrated result ready to hand to the repository's publication policy?

It does not mean automatic merge or deployment.

For Babel public repository work, this should defer to existing repository policy and required checks.

Possible terminal states:

```text
ready_for_draft_pr
not_ready
blocked
```

The release stage should include:

- ship-set inspection;
- secret/public-content checks;
- build/type checks;
- targeted tests;
- changed-file summary;
- known-risk summary;
- intentionally excluded paths;
- required CI expectations.

---

# 17. P10 — Complete

Completion must be an independent runtime decision.

Recommended terminal outcomes:

```ts
type PortableTerminalOutcomeV1 =
  | 'completed_verified'
  | 'completed_unverified'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';
```

`completed_verified` should require:

```text
all required success criteria satisfied
AND
all required verifier receipts current and passing
AND
no unresolved blocker findings
AND
no active stop condition
```

The model's final message is explanatory output, not the source of terminal truth.

---

# 18. WorkflowRunV1

The entire episode should have a portable top-level record.

```ts
interface WorkflowRunV1 {
  schema_version: 1;

  run_id: string;
  workflow_version: 'portable-workflow-v1';
  runtime: 'babel' | 'codex' | string;

  goal: GoalContractV1;

  stages: StageRecordV1[];
  workers: WorkerRunV1[];
  findings: ReviewFindingV1[];
  attacks: AttackScenarioV1[];
  verifications: VerificationReceiptV1[];

  terminal_outcome: PortableTerminalOutcomeV1;
  completion_reason: string;

  started_at: string;
  completed_at?: string;
}
```

The purpose is not to force every runtime to store identical internals. The purpose is to allow a compatible adapter to emit a comparable workflow record.

---

# 19. Babel-native implementation architecture

Babel should be the first full implementation because many pieces already exist.

Recommended package shape:

```text
babel-cli/src/workflow/
├── contracts.ts
├── workflowController.ts
├── stageMachine.ts
├── stagePolicy.ts
├── evidenceAdapter.ts
├── completion.ts
├── runtimeAdapter.ts
├── roles/
│   ├── manager.ts
│   ├── mapper.ts
│   ├── reviewer.ts
│   ├── adversary.ts
│   └── verifier.ts
└── adapters/
    └── babelNativeAdapter.ts
```

This path is illustrative; implementation should preserve current package conventions.

## Key rule

Do not create a second executor.

The workflow layer should orchestrate existing Babel services.

Likely reuse targets include:

```text
agentTeams.ts
agentJobs.ts
approvalQueue.ts
workspaceManager.ts
workspaceTransactions.ts
worktreeSafety.ts
requiredVerifierContract.ts
completionVerification.ts
executor/kernel.ts
evidence/episodeStream.ts
agentBenchmarkHarness.ts
```

---

# 20. BabelNativeAdapter

Create an internal adapter interface representing the operations the portable controller needs.

Example:

```ts
interface WorkflowRuntimeAdapter {
  orient(input: OrientInput): Promise<OrientationReportV1>;

  spawnWorkers(assignments: WorkerAssignmentV1[]): Promise<WorkerRunV1[]>;

  collectReview(input: ReviewInput): Promise<ReviewFindingV1[]>;

  runAttackScenarios(input: AttackInput): Promise<AttackScenarioV1[]>;

  runVerifiers(verifiers: RequiredVerifier[]): Promise<VerificationReceiptV1[]>;

  integrate(input: IntegrationInput): Promise<IntegrationResultV1>;

  evaluateCompletion(run: WorkflowRunV1): Promise<PortableTerminalOutcomeV1>;
}
```

The Babel adapter would map this onto Babel services.

Example:

```text
spawnWorkers
→ AgentTeamSpec
→ run agent team

runVerifiers
→ required verifier contracts / test runner

integrate
→ agent team merge + workspace safety

evaluateCompletion
→ executor completion authority / workflow completion policy
```

---

# 21. Codex adapter concept

Codex should remain independent.

The Babel repository may ship a **portable workflow specification and optional adapter assets**, but Babel should not need to invoke Codex.

A Codex-specific adapter can translate the portable workflow into Codex-native mechanisms.

Conceptually:

```text
Portable Goal Contract
→ Codex-native goal/task instructions

WorkerAssignment
→ Codex parallel agent/worktree assignment

Reviewer role
→ Codex independent review agent

Verifier requirements
→ Codex shell/test/browser/computer-use checks

WorkflowRun evidence
→ Codex task artifacts summarized into portable schema
```

The adapter may live as documentation/templates initially rather than product code.

Possible future location:

```text
adapters/codex/
├── README.md
├── goal-template.md
├── roles/
├── verifier-template.md
└── portable-export-schema.json
```

Again, this adapter is a **translation layer**, not a bridge that makes Codex depend on Babel or vice versa.

---

# 22. User-facing workflow commands

The user-facing API should remain simple.

Possible CLI shape:

```text
babel workflow run <goal-file>
```

or:

```text
babel goal "<goal>"
```

Useful commands:

```text
babel workflow init
babel workflow plan
babel workflow run
babel workflow status
babel workflow inspect
babel workflow verify
babel workflow replay
babel workflow export
```

## `workflow init`

Creates a Goal Contract template.

## `workflow run`

Runs the native Babel implementation.

## `workflow inspect`

Shows:

- current stage;
- workers;
- findings;
- verification status;
- stale receipts;
- blockers;
- remaining budget.

## `workflow replay`

Reconstructs the episode from evidence.

## `workflow export`

Exports the portable `WorkflowRunV1` representation.

This export is what enables cross-harness comparison.

---

# 23. TUI design

The TUI should make the workflow visible without overwhelming the user.

Suggested top-level visualization:

```text
GOAL  provider retry hardening

[✓] Contract
[✓] Orient
[✓] Plan
[✓] Decompose
[~] Implement      2/3 workers complete
[ ] Review
[ ] Attack
[ ] Verify
[ ] Integrate
[ ] Release
[ ] Complete
```

Worker panel:

```text
IMPLEMENTERS

✓ retry-core       4 files   tests pass
~ malformed-path   2 files   running
! reviewer         blocker   stale retry assumption
```

Verification panel:

```text
VERIFICATION

✓ typecheck
✓ provider unit suite
~ timeout integration
- windows portability
```

The TUI should surface **state**, not model narration.

---

# 24. Portable evidence export

Cross-harness reuse becomes much more valuable if results are comparable.

A portable export should answer:

- What was the goal?
- What did the runtime believe the scope was?
- How was work decomposed?
- What changed?
- Which reviews found issues?
- Which attack scenarios were tested?
- Which verifiers passed?
- Which revision did they verify?
- What terminal outcome was assigned?
- Why?

This enables later evaluation such as:

```text
same task
Babel runtime vs Codex runtime
```

without requiring them to share orchestration code.

---

# 25. Harness comparison mode

A later high-value feature is **paired workflow evaluation**.

The same frozen Goal Contract is run independently through two harnesses.

Example:

```text
Task Fixture #27

                    Babel      Codex
--------------------------------------
Goal success         PASS       PASS
Tests passed         14/14      14/14
False complete       no         no
Human interventions  1          2
Iterations           4          5
Files changed        6          8
Regression found     yes        yes
Reviewer blockers    1          2
Wall time            ...        ...
Token/cost            ...        ...
```

This would let Babel answer a much more useful question than generic benchmark scores:

> Which harness executes this engineering workflow more reliably for this class of task?

---

# 26. Workflow profiles

Not every task should run the full expensive workflow.

Define profiles.

## `fast`

```text
Contract
Orient
Implement
Verify
Complete
```

Use for small, low-risk changes.

## `standard`

```text
Contract
Orient
Plan
Implement
Review
Verify
Integrate
Complete
```

Default engineering workflow.

## `hardened`

```text
Contract
Orient
Plan
Decompose
Implement
Review
Attack
Verify
Integrate
Release Gate
Complete
```

Use for shared contracts, execution, evidence, permissions, security, or releases.

## `research`

```text
Contract
Orient
Plan
parallel hypotheses
scored evaluation
Verify
Synthesize
Complete
```

Use for optimization and empirical engineering tasks.

---

# 27. Scored improvement loop

The portable protocol should support a special iterative stage for measurable optimization.

```text
baseline
→ hypothesis
→ candidate
→ semantic gate
→ score
→ retain/reject
→ repeat
```

Suitable Babel examples:

- context token efficiency;
- TUI latency;
- benchmark success rate;
- replay throughput;
- false-completion reduction;
- average repair iterations;
- verifier execution time.

The portable contract should distinguish:

```text
semantic gates
```

from:

```text
optimization score
```

A candidate that improves the score but fails semantic verification must be rejected.

---

# 28. Scheduled workflows

The same workflow semantics can later power recurring jobs.

Examples:

## CI triage workflow

```text
Contract
Orient latest failures
Classify
Investigate
Verify diagnosis
Report
```

## Dependency advisory workflow

```text
Contract
Fetch advisories
Map affected packages
Review exploitability
Verify current version exposure
Report
```

## Release readiness workflow

```text
Contract
Inspect release candidate
Run release gates
Review blockers
Produce evidence report
```

The first scheduled workflows should remain read-mostly or proposal-only.

---

# 29. Security model

The portable workflow must define authority explicitly.

## Manager-only actions by default

- integration;
- branch publication;
- draft PR creation;
- approval escalation;
- changing Goal Contract state;
- final completion decision request.

## Worker restrictions

Workers should not independently:

- push branches;
- merge;
- deploy;
- alter permissions;
- rewrite shared history;
- change another worker's workspace;
- expand their own write scope.

## Runtime enforcement

Where Babel can enforce a rule structurally, do not leave it only in prompts.

Examples:

- write scopes;
- overlapping scope rejection;
- review-only mutation denial;
- capability allowlists;
- workspace isolation;
- verification gates;
- completion decision;
- protected Git workflow.

---

# 30. Failure taxonomy

Portable workflows need standardized failure classes.

Recommended v1 taxonomy:

```ts
type WorkflowFailureClassV1 =
  | 'goal_ambiguity'
  | 'authority_conflict'
  | 'scope_violation'
  | 'capability_denied'
  | 'implementation_failure'
  | 'review_blocker'
  | 'adversarial_failure'
  | 'verification_failure'
  | 'verification_infra_failure'
  | 'integration_conflict'
  | 'stale_evidence'
  | 'budget_exhausted'
  | 'cancelled'
  | 'external_dependency';
```

Different classes should get different recovery behavior.

Example:

```text
implementation_failure
→ allow bounded repair iteration

verification_infra_failure
→ retry verifier or mark blocked

scope_violation
→ stop worker and return to manager

authority_conflict
→ stop workflow
```

---

# 31. Recovery policy

The workflow should treat repair as a bounded state transition rather than an unbounded conversation.

Example:

```text
VERIFY FAIL
   ↓
classify failure
   ↓
implementation defect?
   ├─ yes → repair budget → IMPLEMENT
   └─ no
       ↓
infra failure?
   ├─ yes → verifier retry budget
   └─ no → BLOCKED
```

Each repair iteration should invalidate affected prior verification receipts.

---

# 32. Implementation roadmap

The roadmap should be capability-gated.

## Phase 0 — Freeze the portable contract

### Deliverables

- `GoalContractV1`;
- `WorkflowRunV1`;
- stage enum;
- role enum;
- verification receipt;
- review finding;
- attack scenario;
- failure taxonomy;
- terminal outcomes.

### Acceptance criteria

- schemas serialize deterministically;
- invalid transitions are rejected;
- contracts do not duplicate normative harness authority;
- existing Babel concepts map cleanly into the portable types.

---

## Phase 1 — Workflow state machine

Implement the stage lifecycle independently of model behavior.

Suggested state transitions:

```text
CONTRACT
→ ORIENT
→ PLAN
→ DECOMPOSE
→ IMPLEMENT
→ REVIEW
→ ATTACK
→ VERIFY
→ INTEGRATE
→ RELEASE_GATE
→ COMPLETE
```

Support legal skip transitions based on workflow profile.

### Acceptance criteria

- illegal backwards jumps fail unless explicitly defined as repair transitions;
- every transition emits evidence;
- workflow can resume after process restart;
- current state is reconstructable from persisted evidence.

---

## Phase 2 — Babel-native adapter

Wire workflow stages into existing services.

### Likely mappings

```text
DECOMPOSE / IMPLEMENT
→ agentTeams

job persistence / retries
→ agentJobs

approvals
→ approvalQueue

workspace isolation
→ agentTeams + worktreeSafety + workspace manager

verification
→ requiredVerifierContract / existing test execution

completion
→ executor kernel + completion verification

evidence
→ episode stream / evidence bundle
```

### Acceptance criteria

- a simple fixture goal executes end-to-end;
- no duplicate executor implementation is introduced;
- existing safety invariants remain enforced.

---

## Phase 3 — Manager/worker separation

Formalize authority ownership.

### Deliverables

- manager role;
- mapper role;
- implementer role;
- reviewer role;
- verifier role;
- role capability presets.

### Acceptance criteria

- reviewer cannot write;
- worker cannot expand scope;
- manager receives all worker evidence;
- overlapping writes fail before execution.

---

## Phase 4 — Independent review and attack loop

Add falsification stages.

### Deliverables

- review prompt/skill;
- adversarial scenario generator;
- finding disposition flow;
- seeded-regression fixture suite.

### Acceptance criteria

- reviewer catches at least one seeded defect;
- adversarial stage catches at least one seeded behavioral failure not detected by ordinary tests;
- unresolved blocker prevents verified completion.

---

## Phase 5 — Revision-bound verification

Strengthen verifier receipts.

### Deliverables

- workspace revision identifier;
- receipt staleness detection;
- automatic invalidation after mutation;
- verifier-to-success-criterion mapping.

### Acceptance criteria

- stale receipt cannot authorize completion;
- repair mutation automatically requires re-verification;
- verifier infrastructure errors are distinguishable from product failures.

---

## Phase 6 — Workflow TUI

Expose state clearly.

### Deliverables

- stage progress view;
- worker state;
- finding state;
- verification matrix;
- blocker explanation;
- remaining budgets.

### Acceptance criteria

- user can tell why the workflow is not complete without reading model transcript;
- stale verifier evidence is visible;
- blocked vs failed vs cancelled are visually distinct.

---

## Phase 7 — Portable export

### Deliverables

- JSON export;
- JSON schema;
- human-readable Markdown report;
- deterministic fixture exports.

### Acceptance criteria

- the same run can be reconstructed into a stable summary;
- exports contain enough evidence for offline comparison;
- no secret/private path leakage in public exports.

---

## Phase 8 — Codex compatibility pack

This phase does not connect Babel to Codex.

It produces a separate implementation guide/templates allowing Codex to execute the same logical protocol.

### Deliverables

- Goal Contract translation template;
- role templates;
- worktree assignment template;
- review/adversary templates;
- verification template;
- portable result export instructions.

### Acceptance criteria

- the same frozen fixture goal can be run independently in Babel and Codex;
- both produce valid portable workflow exports;
- neither runtime is required for the other to operate.

---

## Phase 9 — Cross-harness evaluation

### Deliverables

- fixed task fixture set;
- scoring script;
- comparison dashboard/report;
- repeated-run methodology.

### Metrics

- success rate;
- false-completion rate;
- intervention count;
- verifier failure rate;
- regression escape rate;
- iterations;
- changed-line count;
- wall time;
- token/cost usage when available.

### Acceptance criteria

- comparison uses the same Goal Contract and success criteria;
- task fixtures are held constant;
- results distinguish harness failure from model/provider failure when possible.

---

# 33. Suggested first vertical slice

Do not begin with every stage and every role.

The recommended first slice is:

```text
Contract
→ Orient
→ Plan
→ Implement
→ Review
→ Verify
→ Complete
```

Use one manager and one implementer.

## Pilot task

Choose a bounded Babel reliability task with:

- clear existing tests;
- known affected paths;
- deterministic success criteria;
- no production side effects;
- no migration;
- no broad architectural rewrite.

A suitable class of tasks would be a small executor/evidence/replay reliability issue with a seeded failing fixture.

## Pilot acceptance criteria

1. Goal Contract is persisted before mutation.
2. Orientation identifies correct repository authority.
3. Implementer works in an isolated worktree.
4. Reviewer is read-only.
5. Verifier is independent from implementer self-report.
6. Verification receipt is revision-bound.
7. Completion fails when the seeded defect remains.
8. Completion passes after the defect is fixed and all required receipts are current.
9. Entire run can be replayed from evidence.

---

# 34. Recommended file-level implementation sequence

This section is directional rather than authoritative.

## Batch A — contracts only

Potential new surface:

```text
babel-cli/src/workflow/contracts.ts
babel-cli/src/workflow/contracts.test.ts
```

Implement:

- stage enum;
- roles;
- GoalContractV1;
- WorkflowRunV1;
- findings;
- receipts;
- terminal outcomes.

No agent behavior yet.

## Batch B — state machine

Potential surface:

```text
babel-cli/src/workflow/stageMachine.ts
babel-cli/src/workflow/stageMachine.test.ts
```

Implement legal transitions and repair loops.

## Batch C — evidence persistence

Adapt existing episode infrastructure.

Avoid inventing a parallel event log.

## Batch D — Babel runtime adapter

Integrate existing services.

## Batch E — first CLI entrypoint

Minimal command:

```text
babel workflow run <goal.json>
```

## Batch F — reviewer/verifier separation

Use existing agent-team role restrictions.

## Batch G — TUI presentation

Only after the headless workflow is reliable.

## Batch H — portable export

Only after the internal workflow record stabilizes.

---

# 35. Tests required before promotion

## Schema tests

- malformed Goal Contract;
- unknown stage;
- missing criterion;
- duplicate IDs;
- invalid verifier mapping.

## State-machine tests

- legal path;
- illegal transition;
- repair loop;
- cancellation;
- budget exhaustion;
- resume.

## Scope tests

- write outside scope;
- overlapping workers;
- reviewer write attempt.

## Verification tests

- required pass;
- required fail;
- optional fail;
- infra error;
- stale receipt;
- mutation after pass.

## Completion tests

- all criteria satisfied;
- missing receipt;
- stale receipt;
- open blocker;
- partial result;
- false model completion claim.

## Evidence tests

- crash/restart;
- corrupted event;
- replay;
- deterministic export.

---

# 36. Promotion gates

Do not make the portable workflow the default until it demonstrates value.

Recommended gates:

## Gate 1 — correctness

No regression in existing harness conformance tests.

## Gate 2 — false completion

The portable workflow must not increase false-completion rate relative to the current controller path.

## Gate 3 — operator burden

The workflow should reduce or maintain human intervention count on representative tasks.

## Gate 4 — cost

Additional roles must show measurable reliability benefit before becoming default.

## Gate 5 — latency

Small tasks should not be forced through the full hardened workflow.

## Gate 6 — replay

A completed run must be explainable from persisted evidence.

---

# 37. Metrics

Track at minimum:

## Reliability

- verified task success;
- false completion;
- regression escape;
- stale-receipt attempts;
- reviewer blockers found;
- attack-stage defects found.

## Efficiency

- agent count;
- repair iterations;
- wall time;
- tokens/cost when available;
- human interventions.

## Scope discipline

- write-scope violations;
- overlapping work assignments;
- changed files outside plan;
- rollback frequency.

## Verification quality

- verifier failure rate;
- infrastructure failure rate;
- percentage of success criteria mapped to executable oracles.

---

# 38. Key design risks

## Risk: building a second harness inside Babel

Mitigation:

```text
workflow controller orchestrates existing services
```

not:

```text
workflow controller reimplements executor/services
```

## Risk: portability becomes lowest-common-denominator design

Mitigation:

The portable contract defines semantics only. Runtime adapters may use richer native capabilities.

## Risk: every task becomes expensive multi-agent work

Mitigation:

Profiles: `fast`, `standard`, `hardened`, `research`.

## Risk: reviewer and verifier duplicate effort

Mitigation:

Reviewer analyzes reasoning/diff risk. Verifier executes oracles.

## Risk: portable export becomes another source of truth

Mitigation:

It is a derived interoperability artifact. Babel's native evidence remains authoritative for Babel runtime decisions.

## Risk: Codex-specific assumptions leak into Babel

Mitigation:

No Codex types in core portable contracts. Codex translation belongs only in the Codex compatibility pack.

---

# 39. Definition of done for Portable Workflow v1

Portable Workflow v1 is complete when all of the following are true:

1. Babel accepts a frozen Goal Contract.
2. Babel executes a defined workflow profile through a deterministic state machine.
3. Worker scopes and roles are structurally enforced.
4. Mutable parallel work is isolated.
5. Review is logically independent from implementation.
6. Required verification is mapped to explicit success criteria.
7. Verification receipts are revision-bound.
8. Stale evidence cannot authorize verified completion.
9. Completion is decided outside model self-report.
10. The run survives restart/resume.
11. The run can be replayed from persisted evidence.
12. Babel can export a portable workflow report.
13. A Codex compatibility template can execute the same logical fixture independently.
14. Babel and Codex results can be compared without either runtime depending on the other.
15. Existing Babel harness conformance and public release gates continue to pass.

---

# 40. Highest-leverage implementation order

The recommended priority is:

```text
1. Contracts
2. State machine
3. Babel-native adapter
4. Revision-bound verifier mapping
5. Reviewer separation
6. Evidence/replay integration
7. CLI surface
8. Hardened adversarial stage
9. TUI workflow view
10. Portable export
11. Codex compatibility pack
12. Cross-harness benchmark mode
13. Scheduled workflows
14. Scored optimization loops
```

This order matters.

The portability and advanced autonomy features become valuable only after the core workflow has trustworthy state, evidence, scope, and completion semantics.

---

# 41. Final architecture

The intended end state is:

```text
                         USER GOAL
                            │
                            ▼
                 ┌──────────────────────┐
                 │ GoalContractV1       │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Portable Workflow v1 │
                 │ state + semantics    │
                 └──────────┬───────────┘
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
    ┌─────────────────┐           ┌─────────────────┐
    │ Babel adapter   │           │ Codex adapter   │
    └────────┬────────┘           └────────┬────────┘
             │                             │
             ▼                             ▼
    Babel native runtime          Codex native runtime
    - controllers                 - native task loop
    - teams                       - native agents
    - worktrees                   - native worktrees
    - verifier kernel             - native verification
    - evidence/replay             - native evidence
             │                             │
             └──────────────┬──────────────┘
                            │
                            ▼
                 Portable Workflow Export
                            │
                            ▼
                 Cross-harness evaluation
```

The result is not a Babel/Codex integration.

It is a **reusable engineering protocol** that Babel implements as a first-class feature and other harnesses can implement independently.

That gives Babel two benefits at once:

1. a stronger native software-engineering workflow for its own users; and
2. a neutral framework for measuring Babel against other coding-agent harnesses on the workflows that actually matter.
