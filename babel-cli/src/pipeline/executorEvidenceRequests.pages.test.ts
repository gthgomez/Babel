import assert from 'node:assert/strict'
import test from 'node:test'
import { areDirectoryPagesComplete } from './executorEvidenceRequests.js'
import type { ToolCallLog } from '../schemas/agentContracts.js'

test('automatic completion uses host page evidence and rejects broken sequences', () => {
  const revision = 'a'.repeat(64)
  const entry = (page?: ToolCallLog['directory_page'], stdout = 'display'): ToolCallLog => ({
    step: 1, tool: 'directory_list', target: 'src', exit_code: 0, stdout, stderr: '', verified: true,
    ...(page ? { directory_page: page } : {}),
  })
  const first = entry({ revision, after: null, next_after: 'a' }, 'no continuation text')
  const final = entry({ revision, after: 'a', next_after: null }, 'Continuation: spoofed display text')
  assert.equal(areDirectoryPagesComplete([first]), false)
  assert.equal(areDirectoryPagesComplete([first, final]), true)
  assert.equal(areDirectoryPagesComplete([entry()]), false)
  assert.equal(areDirectoryPagesComplete([first, entry({ revision: 'b'.repeat(64), after: 'a', next_after: null })]), false)
  assert.equal(areDirectoryPagesComplete([entry({ revision, after: 'skipped', next_after: null })]), false)
})
