/**
 * Regression: criterion completion must scope governed mutation and candidate revision
 * to the active objective task (same contract as ChatEngine activeObjectiveSessionLog).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasScopedPathListGovernedMutationLineage } from '../authority/criterionNativePathListEvidence.js'
import { mutationPathsFromSessionEvents } from '../evidence/chatRevisionBinding.js'
import {
  LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
  type LiveSessionFilesystemPathListAdmissionV1,
} from './liveSessionFilesystemPathListAdmission.js'
import { TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND } from '../authority/trustedHostFilesystemPathList.js'
import { activeObjectiveSessionLog, type TaskObjectiveLifecycleV1 } from './taskObjectiveLifecycle.js'
import type { SessionEventLog } from './sessionEventSchema.js'
import { SESSION_EVENT_SCHEMA_VERSION } from './sessionEventSchema.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'

const TARGET_DOC = 'meta/tree-index.md'

function pathListAdmissionForTask(userRequest: string): LiveSessionFilesystemPathListAdmissionV1 {
  return {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    user_request_digest: 'digest-task-2',
    project_root_real: '/tmp/fixture',
    admission_record_digest: 'digest',
    declaration: {
      schema_version: 1,
      kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
      declaration_id: 'decl-2',
      user_request: userRequest,
      user_request_digest: 'digest-task-2',
      target_document: TARGET_DOC,
      format_profile: 'markdown_bullet_paths',
      inventory_scope: { roots: ['apps'] },
      coverage: { mode: 'complete_scoped_inventory' },
      preserved_input_selectors: [],
      limits: { max_document_bytes: 32_000, max_entries: 128 },
    },
    preserved_baseline: {
      schema_version: 1,
      kind: 'filesystem_source_baseline_v1',
      declaration_hash: 'hash',
      project_root_real: '/tmp/fixture',
      captured_at: '2026-01-01T00:00:00.000Z',
      preserved: {},
      inventory_snapshot: [],
    },
  }
}

function twoObjectiveSessionLog(): SessionEventLog {
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    session_id: 'session-fixture',
    nextSeq: 2,
    flushedThroughSeq: 1,
    events: [
      {
        schema_version: SESSION_EVENT_SCHEMA_VERSION,
        event_id: 'evt-mutation-task-1',
        session_id: 'session-fixture',
        seq: 1,
        kind: 'mutation_batch',
        turn_id: '1',
        ts: '2026-01-01T00:00:01.000Z',
        paths: [TARGET_DOC],
      },
    ],
  }
}

const contractOne = freezeTaskContract(
  buildTaskContractV1({
    mode: 'chat',
    task_id: 'task-1',
    user_request: 'First objective path index',
    acceptance_criteria: ['First objective path index'],
  }),
)
const contractTwo = freezeTaskContract(
  buildTaskContractV1({
    mode: 'chat',
    task_id: 'task-2',
    user_request: 'Refresh the path index for task two only.',
    acceptance_criteria: ['Refresh the path index for task two only.'],
  }),
)

const lifecycle: TaskObjectiveLifecycleV1 = {
  schema_version: 1,
  active_task_id: 'task-2',
  objectives: [{ taskContract: contractOne }, { taskContract: contractTwo }],
  attempts: [
    {
      task_id: 'task-1',
      contract_id: contractOne.contract_id,
      contract_hash: contractOne.contract_hash,
      attempt_id: 'attempt-1',
      turn_id: '1',
      submission_event_id: 'sub-1',
      admission_event_id: 'adm-1',
      input_digest: 'c'.repeat(64),
    },
    {
      task_id: 'task-2',
      contract_id: contractTwo.contract_id,
      contract_hash: contractTwo.contract_hash,
      attempt_id: 'attempt-2',
      turn_id: '2',
      submission_event_id: 'sub-2',
      admission_event_id: 'adm-2',
      input_digest: 'd'.repeat(64),
    },
  ],
}

test('two-objective: same-file prior-task mutation cannot certify active task path-list lineage', () => {
  const log = twoObjectiveSessionLog()
  const admission = pathListAdmissionForTask('Refresh the path index for task two only.')
  const unscoped = hasScopedPathListGovernedMutationLineage({
    admission,
    events: log.events,
  })
  assert.equal(
    unscoped,
    true,
    'unscoped session events incorrectly reuse the prior objective mutation',
  )
  const scopedEvents = activeObjectiveSessionLog(log, lifecycle).events
  assert.equal(
    hasScopedPathListGovernedMutationLineage({ admission, events: scopedEvents }),
    false,
    'active-task session scope must not inherit prior objective mutation batches',
  )
})

test('two-objective: candidate revision paths exclude prior-task mutations on the same file', () => {
  const log = twoObjectiveSessionLog()
  const scopedEvents = activeObjectiveSessionLog(log, lifecycle).events
  assert.deepEqual(mutationPathsFromSessionEvents(log.events), [TARGET_DOC])
  assert.deepEqual(mutationPathsFromSessionEvents(scopedEvents), [])
})
