import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendTurnCells, listThreads, loadThreadCells } from '../../services/threadStore/index.js'
import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js'
import type { ReplContext } from '../context.js'
import { handleFork, handleRewind } from './threadBranch.js'

test('active work fences real fork and rewind before store or engine changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-branch-admission-'))
  const previousRuns = process.env['BABEL_RUNS_DIR']; process.env['BABEL_RUNS_DIR'] = root
  const thread = 'chat-branch-admission'; let closed = 0
  try {
    appendTurnCells(thread, 1, [{ schema_version: HISTORY_CELL_SCHEMA_VERSION, cell_id: 'cell-u1', thread_id: thread, turn_id: 1, ts: new Date().toISOString(), kind: 'user_message', lifecycle: 'committed', revision: 0, payload: { message: 'fixture' } }])
    const before = loadThreadCells(thread); const threads = await listThreads()
    const engine = { getEngineRunId: () => thread, closeAdmissionStore: () => { closed++ } }
    for (const busy of [{ isRunning: true }, { preparingRun: true }]) {
      const ctx = { ...busy, chatEngine: engine } as unknown as ReplContext
      await assert.rejects(handleFork(ctx, ['cell-u1']), /active.*settle/i)
      await assert.rejects(handleRewind(ctx, ['cell-u1']), /active.*settle/i)
      assert.deepEqual(loadThreadCells(thread), before)
      assert.deepEqual(await listThreads(), threads)
      assert.equal(ctx.chatEngine, engine); assert.equal(closed, 0)
      assert.equal(ctx.isRunning ?? false, busy.isRunning ?? false); assert.equal(ctx.preparingRun ?? false, busy.preparingRun ?? false)
    }
    const idle = { isRunning: false, chatEngine: engine, resolveCurrentTarget: () => ({ targetRoot: root, workspaceRoot: null }) } as unknown as ReplContext
    const pending = handleFork(idle, ['missing-cell'])
    assert.equal(idle.preparingRun, true)
    await assert.rejects(handleRewind(idle, ['cell-u1']), /active.*settle/i)
    await pending
    assert.equal(idle.preparingRun, false)
    assert.equal(idle.chatEngine, engine); assert.equal(closed, 0)
  } finally {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = previousRuns
    rmSync(root, { recursive: true, force: true })
  }
})
