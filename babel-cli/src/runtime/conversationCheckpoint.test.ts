import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { reconstructPreCompactionView, resumeCapsuleContext } from '../services/resumeReplay.js'
import { CondensationFactEmitter } from '../services/condensationFacts.js'
import {
  prepareContextCheckpoint,
  prepareConversationCheckpoint,
  validateContextCheckpoint,
  validateColdResume,
  installContextCheckpoint,
  type LiveOperationalSourcesV1,
  type ContextCheckpoint,
} from './contextCheckpoints.js'

const owner = { threadId: 'conversation-thread', generation: 3, token: 'fixture-owner' }
const lineageEvidence = { threadEvents: [], sessionEvents: [] }

function sources(): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: { goal: 'continue the admitted task', acceptance_clause_ids: ['accept-1'], contract_hash: 'task-hash' },
    working_state: { current_hypothesis: 'retain operational state', unresolved_failures: ['test pending'], next_experiment: 'run verifier' },
    workspace: null,
    receipts: [{ receipt_id: 'old-verifier', identity: 'npm test', scope: 'selected-files', stale: true, bound_revision: 'old-revision', exit_code: 0 }],
    budget: { owner: 'budget-owner', remaining_allowance: 7, cancellation_owner: 'budget-owner' },
    pending: [{ handle_id: 'unsettled-operation', kind: 'operation', state: 'indeterminate' }],
    route: { compiled_request_identity: 'actual-request-digest', tool_profile: 'native-tools', model_route: 'openrouter:deepseek/fixture' },
    observations: [], observation_manifest: [], authorized_observation_ids: [], legacy_observation_refs: [],
  }
}

function prepared() {
  const result = prepareConversationCheckpoint({ checkpointId: 'conversation-checkpoint', owner, sources: sources() })
  assert.equal(result.status, 'prepared')
  if (result.status !== 'prepared') throw new Error('Fixture checkpoint was not prepared')
  return result.checkpoint
}

function redigest(value: unknown): ContextCheckpoint {
  const record = structuredClone(value) as Record<string, unknown>
  delete record['checkpoint_digest']
  return { ...record, checkpoint_digest: sha256Canonical(record) } as unknown as ContextCheckpoint
}

test('conversation continuation retains operational authority without repository certification', () => {
  const checkpoint = prepared()
  assert.equal(checkpoint.schema_version, 2)
  assert.equal(checkpoint.purpose, 'conversation_continuation')
  assert.deepEqual(checkpoint.repository_coverage, { status: 'unavailable', reason: 'not_captured_for_conversation' })
  assert.equal(checkpoint.workspace, null)
  assert.equal(checkpoint.population.workspace_revision_current, false)
  assert.equal(checkpoint.population.workspace_matches_verifier_revision, false)
  assert.equal(checkpoint.population.rows.some(row => row.id === 'workspace_snapshot'), false)
  assert.ok(checkpoint.population.rows.some(row => row.id === 'repository_coverage' && row.gap))
  assert.deepEqual(checkpoint.budget, sources().budget)
  assert.deepEqual(checkpoint.pending, sources().pending)
  assert.deepEqual(checkpoint.receipts, sources().receipts)
  assert.equal(validateContextCheckpoint(checkpoint, { currentOwner: owner, requireInstalledLineage: true, lineageEvidence, authorizedObservationIds: [] }).status, 'valid')
})

test('V1 still refuses an unavailable repository snapshot', () => {
  assert.equal(prepareContextCheckpoint({ checkpointId: 'v1', owner, sources: sources() }).status, 'blocked')
})

test('independently current scoped verification survives without whole-repository coverage', () => {
  const input = sources()
  input.receipts = [{ ...input.receipts[0]!, stale: false, current_for_bound_scope: true }]
  const result = prepareConversationCheckpoint({ checkpointId: 'scoped-receipt', owner, sources: input })
  assert.equal(result.status, 'prepared')
  if (result.status !== 'prepared') return
  assert.equal(result.checkpoint.population.verifier_current_for_bound_scope, true)
  assert.equal(result.checkpoint.population.workspace_revision_current, false)
  assert.equal(result.checkpoint.receipts[0]?.scope, 'selected-files')
})

test('conversation preparation does not downgrade a supplied repository proof', () => {
  const input = sources()
  input.workspace = { current_snapshot_revision: 'historical', capture_complete: true, coverage_ref: 'historical', capture_provenance: 'verifier_relabel', capture_epoch: 'claimed-epoch' }
  assert.equal(prepareConversationCheckpoint({ checkpointId: 'bad-proof', owner, sources: input }).status, 'blocked')
})

test('blocked conversation preparation returns non-authorizing population metadata', () => {
  const input = sources()
  input.budget = { ...input.budget!, cancellation_owner: '' }
  const result = prepareConversationCheckpoint({ checkpointId: 'invalid-cancellation-owner', owner, sources: input })
  assert.equal(result.status, 'blocked')
  assert.equal(result.population.status, 'blocked')
  assert.equal(result.population.install_authorized, false)
  assert.ok(result.population.errors.some(error => error.includes('operational state')))
})

test('conversation cold resume retains gaps and independently bound ownership', () => {
  const checkpoint = prepared()
  const resumed = validateColdResume({ checkpoint, currentOwner: owner, authorizedObservationIds: [], lineageEvidence })
  assert.equal(resumed.status, 'ready')
  const context = resumeCapsuleContext(checkpoint, lineageEvidence, [])
  assert.equal(context.status, 'ready')
  if (context.status !== 'ready') return
  assert.ok(context.gaps.some(gap => gap.kind === 'incomplete_workspace'))
  assert.ok(context.gaps.some(gap => gap.kind === 'stale_receipt'))
  assert.ok(context.gaps.some(gap => gap.kind === 'pending_operation'))
  assert.equal(context.workspace, null)
  assert.equal(validateColdResume({ checkpoint, currentOwner: { ...owner, generation: 4 }, authorizedObservationIds: [], lineageEvidence }).status, 'blocked')
  assert.equal(validateColdResume({ checkpoint, currentOwner: owner, lineageEvidence }).status, 'blocked')
  assert.equal(resumeCapsuleContext(checkpoint, lineageEvidence).status, 'blocked')
})

for (const [label, mutation] of [
  ['certification purpose', (checkpoint: Record<string, unknown>) => { checkpoint['purpose'] = 'repository_certification' }],
  ['V1 relabelling', (checkpoint: Record<string, unknown>) => { checkpoint['schema_version'] = 1 }],
  ['unknown version', (checkpoint: Record<string, unknown>) => { checkpoint['schema_version'] = 3 }],
  ['invented coverage', (checkpoint: Record<string, unknown>) => { checkpoint['repository_coverage'] = { status: 'complete', revision: 'invented' } }],
  ['invented workspace', (checkpoint: Record<string, unknown>) => { checkpoint['workspace'] = { capture_complete: true, current_snapshot_revision: 'invented' } }],
] as const) {
  test(`conversation checkpoint rejects ${label}`, () => {
    const checkpoint = structuredClone(prepared()) as unknown as Record<string, unknown>
    mutation(checkpoint)
    assert.equal(validateContextCheckpoint(redigest(checkpoint), { currentOwner: owner }).status, 'blocked')
  })
}

test('conversation checkpoint digest includes its purpose and unavailable coverage', () => {
  const checkpoint = prepared()
  const tampered = { ...checkpoint, repository_coverage: { status: 'unavailable', reason: 'altered' } } as unknown as ContextCheckpoint
  assert.ok(validateContextCheckpoint(tampered).reasons.includes('checkpoint_digest_mismatch'))
})

for (const [label, mutation] of [
  ['unknown version', (value: Record<string, unknown>) => { value['schema_version'] = 3 }],
  ['string version', (value: Record<string, unknown>) => { value['schema_version'] = '2' }],
  ['legacy relabelling', (value: Record<string, unknown>) => { value['schema_version'] = 1 }],
  ['stripped legacy relabelling', (value: Record<string, unknown>) => {
    value['schema_version'] = 1
    delete value['purpose']
    delete value['repository_coverage']
  }],
  ['relabeled population with conversation rows', (value: Record<string, unknown>) => {
    value['schema_version'] = 1
    delete value['purpose']
    delete value['repository_coverage']
    const population = value['population'] as Record<string, unknown>
    population['schema_version'] = 1
  }],
] as const) test(`conversation replay rejects ${label} before legacy projection`, () => {
  const checkpoint = structuredClone(prepared()) as unknown as Record<string, unknown>
  mutation(checkpoint)
  // Leave the original digest and independently supplied lineage untouched:
  // changing a version must never select a weaker legacy validation path.
  const capsule = checkpoint as unknown as ContextCheckpoint
  for (const membership of [undefined, []] as const) {
    const result = resumeCapsuleContext(capsule, lineageEvidence, membership)
    assert.equal(result.status, 'blocked')
    if (result.status === 'blocked') assert.ok(result.reasons.includes('invalid_schema'))
  }
})

test('pre-compaction reconstruction keeps version rejection at the capsule boundary', () => {
  const checkpoint = prepared()
  let sequence = 0
  const emitter = new CondensationFactEmitter(
    { threadId: owner.threadId, runId: 'conversation-replay' }, () => ++sequence,
    () => '2026-10-18T00:00:00.000Z',
  )
  const started = emitter.begin({ compactionId: 'replay', path: 'chat_engine_inline', countBefore: 100 })
  const completed = emitter.complete({ compactionId: 'replay', countAfter: 10,
    prunedMessageRanges: [{ from: 0, to: 1 }], capsuleCheckpointId: checkpoint.checkpointId })
  assert.ok(started && completed)
  const facts = [started, completed]
  const valid = reconstructPreCompactionView(facts, 'replay', checkpoint, lineageEvidence, [])
  assert.equal(valid.status, 'ready')
  if (valid.status === 'ready') assert.equal(valid.capsule?.status, 'ready')
  const tampered = { ...checkpoint, schema_version: 3 } as unknown as ContextCheckpoint
  const invalid = reconstructPreCompactionView(facts, 'replay', tampered, lineageEvidence, [])
  assert.equal(invalid.status, 'ready')
  if (invalid.status === 'ready') assert.equal(invalid.capsule?.status, 'blocked')
})

for (const [label, mutation] of [
  ['budget', (value: Record<string, unknown>) => { value['budget'] = null }],
  ['request route', (value: Record<string, unknown>) => { value['route'] = null }],
  ['task contract', (value: Record<string, unknown>) => { value['taskContractReference'] = null }],
  ['pending state', (value: Record<string, unknown>) => { delete value['pending'] }],
  ['advisory state', (value: Record<string, unknown>) => { (value['workingStateSnapshot'] as Record<string, unknown>)['authoritative'] = true }],
  ['required row', (value: Record<string, unknown>) => {
    const population = value['population'] as { rows: Array<{ id: string }> }
    population.rows = population.rows.filter(row => row.id !== 'budget')
  }],
  ['coverage flag', (value: Record<string, unknown>) => { (value['population'] as Record<string, unknown>)['workspace_revision_current'] = true }],
] as const) {
  test(`conversation restore refuses malformed ${label} even with a recomputed digest`, () => {
    const value = structuredClone(prepared()) as unknown as Record<string, unknown>
    mutation(value)
    assert.equal(validateContextCheckpoint(redigest(value), { currentOwner: owner, authorizedObservationIds: [] }).status, 'blocked')
  })
}

test('conversation install uses the existing owner fence and failure transaction port', async () => {
  const checkpoint = prepared()
  let calls = 0
  const input = { currentOwner: owner, requireInstalledLineage: true, authorizedObservationIds: [], lineageEvidence,
    readCurrentOwner: () => ({ ...owner, token: 'replacement-owner' }), install: () => { calls++ } }
  assert.equal((await installContextCheckpoint(checkpoint, input)).status, 'blocked')
  assert.equal(calls, 0)
  assert.equal((await installContextCheckpoint(checkpoint, { ...input, readCurrentOwner: () => owner, install: () => { calls++; throw new Error('fixture persistence failure') } })).status, 'blocked')
  assert.equal(calls, 1)
})
