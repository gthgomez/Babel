import assert from 'node:assert/strict'
import test from 'node:test'
import { hasScopedPathListGovernedMutationLineage } from './criterionNativePathListEvidence.js'
import {
  LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
  type LiveSessionFilesystemPathListAdmissionV1,
} from '../agent/liveSessionFilesystemPathListAdmission.js'
import { TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND } from './trustedHostFilesystemPathList.js'

function minimalAdmission(
  overrides?: Partial<LiveSessionFilesystemPathListAdmissionV1['declaration']>,
  admissionOverrides?: Partial<
    Pick<LiveSessionFilesystemPathListAdmissionV1, 'project_root_real'>
  >,
): LiveSessionFilesystemPathListAdmissionV1 {
  const declaration = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: 'decl-1',
    user_request: 'update index',
    user_request_digest: 'abc',
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths' as const,
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' as const },
    preserved_input_selectors: [],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
    ...overrides,
  }
  return {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    user_request_digest: 'abc',
    project_root_real: admissionOverrides?.project_root_real ?? '/tmp/fixture',
    admission_record_digest: 'digest',
    declaration,
    preserved_baseline: {
      schema_version: 1 as const,
      kind: 'filesystem_source_baseline_v1' as const,
      declaration_hash: 'hash',
      project_root_real: admissionOverrides?.project_root_real ?? '/tmp/fixture',
      captured_at: '2026-01-01T00:00:00.000Z',
      preserved: {},
      inventory_snapshot: [],
    },
  }
}

test('hasScopedPathListGovernedMutationLineage accepts target document writes', () => {
  const admission = minimalAdmission()
  assert.equal(
    hasScopedPathListGovernedMutationLineage({
      admission,
      events: [{ kind: 'mutation_batch', paths: ['meta/tree-index.md'] }],
    }),
    true,
  )
})

test('hasScopedPathListGovernedMutationLineage accepts scoped inventory roots', () => {
  const admission = minimalAdmission()
  assert.equal(
    hasScopedPathListGovernedMutationLineage({
      admission,
      events: [{ kind: 'mutation_batch', paths: ['apps/web/entry.mjs'] }],
    }),
    true,
  )
})

test('hasScopedPathListGovernedMutationLineage accepts absolute paths under admitted project root', () => {
  const admission = minimalAdmission(undefined, { project_root_real: '/tmp/fixture' })
  assert.equal(
    hasScopedPathListGovernedMutationLineage({
      admission,
      events: [{ kind: 'mutation_batch', paths: ['/tmp/fixture/meta/tree-index.md'] }],
    }),
    true,
  )
})

test('hasScopedPathListGovernedMutationLineage rejects unrelated mutation batches', () => {
  const admission = minimalAdmission()
  assert.equal(
    hasScopedPathListGovernedMutationLineage({
      admission,
      events: [{ kind: 'mutation_batch', paths: ['docs/unrelated.md'] }],
    }),
    false,
  )
  assert.equal(
    hasScopedPathListGovernedMutationLineage({
      admission,
      events: [{ kind: 'mutation_batch', paths: [] }],
    }),
    false,
  )
})
