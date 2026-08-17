/**
 * Cross-stack: #93 coding-loop edit/read path still obeys #88 lease/PDP.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLeaseJson } from '../../authority/lease.js'
import { decideWithLease, resetLeaseInvalidations } from '../../authority/wire.js'
import { establishAuthoritySession } from '../../authority/sessionContext.js'
import { executeActionWithPolicy, createToolExecutor } from '../toolExecutor.js'
import { selectReadWindow } from './readWindow.js'
import { isCredentialDeniedOutput } from './observationCompiler.js'

test('write_file / apply_patch deny without edit_task_files after rebase', () => {
  resetLeaseInvalidations()
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'cross-93',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['inspect_repository', 'search_repository', 'run_tests'],
    }),
  )
  assert.ok(parsed.ok)
  const root = mkdtempSync(join(tmpdir(), 'babel-x93-'))
  try {
    const ctx = { lease: parsed.lease, baseline: { repoRoot: root, manifest: { schemaVersion: 1 as const, entries: [], capturedAt: new Date().toISOString() } } }
    assert.equal(
      decideWithLease({ type: 'write_file', path: 'a.ts', content: 'x' }, 'workspace_write', ctx).decision,
      'deny',
    )
    assert.equal(
      decideWithLease({ type: 'apply_patch', patch: 'diff --git a/a b/a\n' }, 'workspace_write', ctx).decision,
      'deny',
    )
    const window = selectReadWindow('a\n'.repeat(80), { kind: 'range', startLine: 200, endLine: 250 })
    assert.equal(window.lines.length, 0)
    assert.equal(isCredentialDeniedOutput('[DENY_CREDENTIAL_READ]'), true)
  } finally {
    resetLeaseInvalidations()
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalidated session blocks a post-rebase write', async () => {
  resetLeaseInvalidations()
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'cross-93-inv',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['edit_task_files', 'inspect_repository'],
    }),
  )
  assert.ok(parsed.ok)
  const root = mkdtempSync(join(tmpdir(), 'babel-x93i-'))
  try {
    writeFileSync(join(root, 'a.ts'), 'ok\n')
    const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease })
    session.invalidated = true
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'nope\n' },
      'workspace_write',
      { agentId: 'x', runId: 'x', babelRoot: root },
      {
        authoritySession: session,
        executor: createToolExecutor({
          executeTool: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
        }),
      },
    )
    assert.equal(result.policyBlocked, true)
  } finally {
    resetLeaseInvalidations()
    rmSync(root, { recursive: true, force: true })
  }
})
