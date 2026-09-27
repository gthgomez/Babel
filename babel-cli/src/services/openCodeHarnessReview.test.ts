import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createOpenCodeHarnessAdapter } from './openCodeHarnessReview.js'
import type { HarnessReviewRequest } from './harnessReviewProtocol.js'

test('OpenCode fallback supplies exact diff and attests an observed session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-harness-'))
  try {
    const snapshot = join(root, 'snapshot')
    mkdirSync(snapshot)
    const diff = 'diff --git a/a b/a\n+x\n'
    writeFileSync(join(snapshot, 'changes.diff'), diff)
    const request = {
      controller_run_id: 'run-1', challenge_id: 'challenge-1', snapshot_root: snapshot,
      diff_sha256: createHash('sha256').update(diff).digest('hex'), diff_lines_total: 2,
      purpose: 'FINAL_CERTIFICATION',
      authority: 'SESSION_ATTESTED',
      builder: { kind: 'codex', principal_id: 'builder', execution_id: 'builder-thread' },
      reviewer: { kind: 'opencode', principal_id: 'slot', execution_id: 'slot-exec' },
      candidate: { repository: 'gthgomez/Babel', pr_number: 267, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
        candidate_digest: 'c'.repeat(64), diff_numstat_digest: 'd'.repeat(64), task_id: 'pr-267', task_hash: 'e'.repeat(64),
        scope: ['a'], builder_id: 'builder', risk_tier: 'NORMAL', schema_version: 2, trust_mode: 'SELF_REVIEW',
        created_at: new Date().toISOString() },
    } as HarnessReviewRequest
    const adapter = createOpenCodeHarnessAdapter({ model: 'provider/model', agentConfigPath: join(root, 'opencode.json'), sourceSha: 'a'.repeat(40), authority: 'SESSION_ATTESTED',
      spawnFn: async (spawnRequest) => {
        assert.match(spawnRequest.prompt, /\+x/)
        return { exitCode: 0, sessionId: 'opencode-session', events: [{ type: 'text', text: JSON.stringify({
          verdict: 'APPROVE', findings: [], blocking_findings: [], reviewed_files: ['a'], diff_consumed: true,
        }) }] }
      } })
    const result = await adapter.review(request)
    assert.equal(result.host_observation.child_execution_id, 'opencode-session')
    assert.equal(result.host_observation.diff_lines_read, 2)
    assert.equal(result.host_observation.authority, 'SESSION_ATTESTED')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('OpenCode fallback attests only SESSION_ATTESTED and refuses host-protected authority', () => {
  const base = { model: 'provider/model', agentConfigPath: 'unused.json', sourceSha: 'a'.repeat(40) } as const
  assert.equal(createOpenCodeHarnessAdapter({ ...base, authority: 'SESSION_ATTESTED' }).capabilities().authority, 'SESSION_ATTESTED')
  assert.equal(createOpenCodeHarnessAdapter(base).capabilities().authority, 'SESSION_ATTESTED')
  assert.throws(() => createOpenCodeHarnessAdapter({ ...base, authority: 'HOST_PROTECTED' }), /HARNESS_AUTHORITY_INSUFFICIENT/)
})
