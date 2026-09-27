import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodexHarnessAdapter, codexParentIdentity, trustedCodexExecutable } from './codexHarnessReview.js'
import type { HarnessReviewRequest } from './harnessReviewProtocol.js'

function request(): { root: string; request: HarnessReviewRequest } {
  const root = mkdtempSync(join(tmpdir(), 'codex-harness-'))
  const snapshot = join(root, 'snapshot')
  mkdirSync(snapshot)
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+fixed\n'
  writeFileSync(join(snapshot, 'changes.diff'), diff)
  const candidate = {
    repository: 'gthgomez/Babel', pr_number: 267, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    candidate_digest: 'c'.repeat(64), diff_numstat_digest: 'd'.repeat(64), task_id: 'pr-267',
    task_hash: 'e'.repeat(64), scope: ['src/a.ts'], builder_id: 'parent', risk_tier: 'NORMAL',
    schema_version: 2, trust_mode: 'SELF_REVIEW', created_at: new Date().toISOString(),
  } as HarnessReviewRequest['candidate']
  return { root, request: {
    controller_run_id: 'run-1', challenge_id: 'challenge-1', candidate,
    builder: { kind: 'codex', principal_id: 'parent', execution_id: 'parent-thread' },
    reviewer: { kind: 'codex', principal_id: 'reviewer', execution_id: 'reviewer-slot' },
    snapshot_root: snapshot, diff_sha256: createHash('sha256').update(diff).digest('hex'),
    diff_lines_total: 2, purpose: 'FINAL_CERTIFICATION',
  } }
}

test('Codex adapter requires an observed fresh thread and full-diff acknowledgement', async () => {
  const f = request()
  try {
    const adapter = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40),
      spawnFn: async (_request, prompt) => {
        assert.match(prompt, /\+fixed/)
        return { exitCode: 0, events: [
          { type: 'thread.started', thread_id: 'child-thread' },
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
            verdict: 'approve', findings: [], blocking_findings: [], diff_consumed: true,
          }) } },
          { type: 'turn.completed' },
        ] }
      },
    })
    const result = await adapter.review(f.request)
    assert.equal(result.verdict, 'APPROVE')
    assert.equal(result.host_observation.child_execution_id, 'child-thread')
    assert.equal(result.host_observation.read_only_enforced, true)
    assert.equal(result.host_observation.controller_state_isolated, true)
    assert.equal(result.host_observation.diff_lines_read, 2)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Codex parent identity comes from the active host thread', () => {
  const thread = '01a0dfc1-0da7-7733-82ab-0ea04efd4b29'
  assert.deepEqual(codexParentIdentity({ CODEX_THREAD_ID: thread, CODEX_SESSION_ID: thread }), {
    kind: 'codex', principal_id: thread, execution_id: thread,
  })
  assert.throws(() => codexParentIdentity({ CODEX_THREAD_ID: 'forged', CODEX_SESSION_ID: thread }), /CODEX_PARENT_IDENTITY_UNAVAILABLE/)
  assert.throws(() => codexParentIdentity({ CODEX_THREAD_ID: thread, CODEX_SESSION_ID: 'different' }), /CODEX_PARENT_IDENTITY_UNAVAILABLE/)
})

test('standalone Codex launch rejects a coding-user-owned executable', () => {
  if (process.platform === 'win32' || process.getuid?.() === undefined) return
  const root = mkdtempSync(join(tmpdir(), 'untrusted-codex-'))
  try {
    writeFileSync(join(root, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    assert.throws(() => trustedCodexExecutable(root), /TRUSTED_CODEX_LAUNCHER_REQUIRED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Codex adapter fails closed when child identity or diff acknowledgement is absent', async () => {
  const f = request()
  try {
    const adapter = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40), spawnFn: async () => ({ exitCode: 0, events: [
      { type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"APPROVE","findings":[],"blocking_findings":[],"diff_consumed":false}' } },
      { type: 'turn.completed' },
    ] }) })
    await assert.rejects(() => adapter.review(f.request), /CODEX_REVIEW_IDENTITY_OR_DIFF_MISSING/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Codex adapter rejects a later non-JSON correction and an incomplete turn', async () => {
  const f = request()
  try {
    const approval = { type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"APPROVE","findings":[],"blocking_findings":[],"diff_consumed":true}' } }
    const corrected = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40), spawnFn: async () => ({ exitCode: 0, events: [
      { type: 'thread.started', thread_id: 'child-thread' }, approval,
      { type: 'item.completed', item: { type: 'agent_message', text: 'I cannot approve this change.' } },
      { type: 'turn.completed' },
    ] }) })
    await assert.rejects(() => corrected.review(f.request), /CODEX_REVIEW_IDENTITY_OR_DIFF_MISSING/)
    const incomplete = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40), spawnFn: async () => ({ exitCode: 0, events: [
      { type: 'thread.started', thread_id: 'child-thread' }, approval,
    ] }) })
    await assert.rejects(() => incomplete.review(f.request), /CODEX_REVIEW_INCOMPLETE/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Codex adapter rejects tool use and a different submitting parent', async () => {
  const f = request()
  try {
    const toolsUsed = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40), spawnFn: async () => ({ exitCode: 0, events: [
      { type: 'thread.started', thread_id: 'child-thread' },
      { type: 'item.started', item: { type: 'command_execution', command: 'cat /tmp/private' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"APPROVE","findings":[],"blocking_findings":[],"diff_consumed":true}' } },
      { type: 'turn.completed' },
    ] }) })
    await assert.rejects(() => toolsUsed.review(f.request), /CODEX_REVIEW_TOOL_USE_DENIED/)
    const wrongParent = createCodexHarnessAdapter({ parentExecutionId: 'other-thread', sourceSha: 'a'.repeat(40), spawnFn: async () => { throw new Error('SHOULD_NOT_SPAWN') } })
    await assert.rejects(() => wrongParent.review(f.request), /CODEX_PARENT_EXECUTION_MISMATCH/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Codex adapter rejects malformed, incomplete, or trailing event records', async () => {
  const f = request()
  try {
    const complete = [
      { type: 'thread.started', thread_id: 'child-thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"APPROVE","findings":[],"blocking_findings":[],"diff_consumed":true}' } },
      { type: 'turn.completed' },
    ]
    for (const events of [
      [{ type: 'malformed_event' }, ...complete],
      [complete[0], { type: 'item.completed' }, ...complete.slice(1)],
      [...complete, { type: 'item.completed', item: { type: 'agent_message', text: 'Correction: block.' } }],
    ]) {
      const adapter = createCodexHarnessAdapter({ parentExecutionId: 'parent-thread', sourceSha: 'a'.repeat(40),
        spawnFn: async () => ({ exitCode: 0, events }),
      })
      await assert.rejects(() => adapter.review(f.request), /CODEX_REVIEW_TOOL_USE_DENIED/)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
