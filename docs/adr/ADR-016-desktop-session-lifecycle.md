# ADR-016: Desktop session lifecycle and transport migration

**Status:** Accepted for incremental implementation; remaining capabilities are open
**Date:** 2026-10-15
**Deciders:** Desktop implementation, within the owner's product requirements

## Context

Desktop owns a child process and presentation, not a second agent runtime.
`native/child.mjs` currently launches one `babel run` per turn and drains NDJSON.
The headless Chat path restores the same canonical chat session using
`openResumedChatEngine`; conversation-only execution has an explicit null project
root. Child exit, response completion and verified task completion are distinct.

The existing JSON-RPC catalog in `babel-cli/src/protocol` is a useful shared
semantic boundary, but switching transports would not by itself supply the
missing product behavior. These observations describe the candidate, not installed
or live-provider qualification:

| Capability | Per-turn Desktop NDJSON | Protocol/coordinator |
| --- | --- | --- |
| Chat cold resume | Same canonical session, exercised through built CLI and development Electron fixtures | Event/session/context authority reconstruction exists |
| No-project conversation | Explicit scope supported end to end | `ThreadCreateParams.project_root` remains required |
| Plan | Current CLI workflow selects the pipeline path; Desktop does not retain its Chat session binding | Existing ChatEngine adapter; server-side read-only policy |
| Deep | Real pipeline path exists; shared Chat archive/objective handoff remains open | Explicit `MODE_UNSUPPORTED`; never substitute Chat |
| Ownership/cancel | One owned child until actual close; cooperative cancel and containment backstop | Generation-fenced owner; cancel request does not settle execution |
| Queue/steer | Not implemented | No steer method; submit idempotency map is process memory |
| Durable objective | Reuse frozen task contract and authority artifacts | Same owners; protocol transport is not objective authority |

## Decision

Keep the working Desktop NDJSON bridge while extending the shared CLI lifecycle.
Use the runtime coordinator, executor kernel, task contracts, session events and
admission owner as the semantic authorities. A future stdio JSON-RPC bridge must
use those same owners. Do not enable the dormant daemon or build a renderer queue
that independently decides when work runs.

Before changing the Desktop transport, require conformance for explicit scope,
canonical identity, ownership through cancellation/settlement, approval binding,
cold resume and all supported controllers. Unsupported operations must return a
typed capability failure. This decision does not defer the full product scope.

Separate the immutable accepted objective/contract revision from each attempt's
mode, route and owner. Preserve task identity and acceptance through status
questions and mode changes. Do not mutate a frozen contract's `mode` or effects,
or treat a mode selection as evidence that tests passed. A changed objective or
expanded effect authority needs a recorded revision with parent lineage, not a
replacement task inferred from its title. Plan always intersects task authority
with its read-only executor policy. Deep must run the real controller and its
review/evidence path.

Unsent composer text and reading position are client state, separate from
submitted task records. Their native profile storage binds the selected project
scope and, once known, the exact canonical chat ID; it confers no execution or
delivery authority. Durable queue admission must
bind item identity/revision, payload digest, conversation/task and expected turn
before acknowledgement. Retrying a receipt must not dispatch an additional turn;
uncertain tool effects still require reconciliation. These extensions must be
shared CLI services before Desktop projects queue or delivery state.

## Alternatives considered

- Immediate protocol migration: rejected as the first step because its current
  required project root and unsupported Deep/steer paths would regress supported
  behavior or conceal missing controllers.
- Another Desktop task/session runtime: rejected because it would compete with
  frozen contracts, admission, completion and effect recovery.
- Relabel Chat as Deep: rejected because the actual controller and evidence
  obligations differ.

## Consequences and compatibility

The current transport remains supported during incremental work. Additive DTO
fields may be ignored by old readers, but unsupported stored schema/protocol
versions must remain read-only or reject execution. Keep historical session IDs
and artifacts; any new mapping is explicit and resumable. Rollback must not
reinterpret new queue/approval records as old authority. No migration is claimed
by this ADR.

Frozen `TaskContractV1.mode` and the strict manifest/contract mode check are
existing constraints, not fields that can simply be overwritten on a mode switch.
Their revision/attempt binding must be addressed before exposing seamless mode
continuity. The native provider reconstruction of transcript-only legacy prefixes
also remains open; display archive retention does not establish request context.

Chat restores semantic objective/amendment state from canonical `turn_started`
user submissions. New turns retain the requested host operation, intent override
and explicit continuation separately from derived status/counter policy. Replay
never runs tools or restores write-success counters, verifier proof, permissions
or paid request state. A status presentation remains read-only. Legacy turns
without the requested-operation field recover their objective with a read-only
policy because a historical host override cannot be inferred from prose; a new
explicit implementation request can establish the next operation through normal
admission. Transcript-only legacy archives cannot prove this semantic state.
This is not the frozen-contract/attempt revision or complete task lifecycle.
Rewind records a conservative continuity reset in the retained canonical policy
events before truncating display cells. Live resync reloads that boundary and
drops the previous task runtime. A subsequent bare continuation cannot resurrect
the discarded objective; a fresh accepted submission starts new semantic state.
This does not claim canonical provider-context branching or restore deleted work.

## Compliance evidence

VERIFIED on the source candidate `c2e8ae6251e2c8aabd121f0a7bff6ce665a09a61`:
25 deterministic tests passed across `executor/modeAdapters.test.ts`,
`runtime/coordinator.test.ts`, `protocol/client/hostLifecycleOwnership.test.ts`
and `protocol/client/hostResumeReconstruction.test.ts`. The subprocess used a
fresh allowlisted synthetic profile, the no-ambient-inference preload and blocked
network. These test adapters/ownership/restore, not a complete Desktop migration.

Earlier built CLI and development Electron fixtures exercised two consecutive
conversation-only Chat turns with one canonical session. Renderer fixtures cover
bounded older-page continuation and stale-read fencing. Installation, paid
providers, durable queue/steer, mode handoff and full acceptance remain unqualified.
