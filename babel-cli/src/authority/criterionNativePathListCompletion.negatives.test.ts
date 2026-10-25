import assert from 'node:assert/strict'
import test from 'node:test'
import { createCriterionCompletionServiceV1 } from './criterionCompletion.js'
import { assertPathListSessionBinding } from '../agent/liveSessionFilesystemPathListAdmission.js'
import { LiveSessionAuthorityError } from '../agent/liveSessionAuthorityError.js'
import {
  LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
  type LiveSessionFilesystemPathListAdmissionV1,
} from '../agent/liveSessionFilesystemPathListAdmission.js'
import { TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND } from './trustedHostFilesystemPathList.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'

function admissionFixture(
  userRequest: string,
): LiveSessionFilesystemPathListAdmissionV1 {
  return {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    user_request_digest: 'abc',
    project_root_real: '/tmp/fixture',
    admission_record_digest: 'digest',
    declaration: {
      schema_version: 1,
      kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
      declaration_id: 'decl-1',
      user_request: userRequest,
      user_request_digest: 'abc',
      target_document: 'meta/tree-index.md',
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

test('negative: stale path-list verification handle is rejected after authority reset', () => {
  const service = createCriterionCompletionServiceV1(() => ({
    contract: undefined,
    runId: 'run',
    projectRoot: null,
  }))
  const forged = Object.freeze({
    schema_version: 1 as const,
    kind: 'path-list-verification:v1' as const,
  })
  assert.deepEqual(service.evaluateOwnedPathListVerification(forged).errors, [
    'PATH_LIST_REQUEST_UNTRUSTED',
  ])
})

test('negative: path-list session binding rejects stale admission task text', () => {
  const admission = admissionFixture('stale task text')
  const contract = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: 'current task text',
      acceptance_criteria: ['current task text'],
    }),
  )
  assert.throws(
    () =>
      assertPathListSessionBinding({
        projectRoot: admission.project_root_real,
        task: contract.user_request,
        contract,
        admission,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError &&
      error.code === 'PATH_LIST_REQUEST_MISMATCH',
  )
})
