import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadShellActionRows,
  loadShellProjectRows,
  mapShellSessionRows,
  ShellSources,
} from './shellSources.js'

test('action rows come from the shared slash-command catalog and include a real New', () => {
  const rows = loadShellActionRows()
  assert.equal(rows[0]?.id, '/clear')
  assert.deepEqual(rows[0]?.command, { kind: 'session.new' })
  assert.ok(rows.some((row) => row.id === '/diff' && row.command?.kind === 'action.run'))
  assert.ok(rows.some((row) => row.id === '/resume'))
  // Destructive/terminal commands stay out of the shell action panel.
  assert.equal(rows.some((row) => row.id === '/exit'), false)
})

test('project rows map directories to in-place expansion and keep files informational', () => {
  const rows = loadShellProjectRows('/repo', () => ['[dir] src', '[file] README.md', 'plain'])
  assert.deepEqual(rows[0], {
    id: '/repo/src',
    label: '[dir] src',
    command: { kind: 'project.toggle', root: '/repo/src' },
  })
  assert.equal(rows[1]?.command, undefined)
  assert.equal(rows[2]?.id, 'plain')
})

test('session rows keep the real session id and resume command', () => {
  const rows = mapShellSessionRows([
    {
      id: 'session-1',
      mtimeMs: 1,
      turnCount: 4,
      preview: 'fix the tests',
      transcriptPath: '/tmp/t.jsonl',
    },
  ])
  assert.deepEqual(rows[0], {
    id: 'session-1',
    label: 'fix the tests  (4 msgs)',
    command: { kind: 'session.resume', id: 'session-1' },
  })
})

test('ShellSources reports real empty/error state and caches the project listing', async () => {
  let projectListCalls = 0
  const sources = new ShellSources(
    async () => [],
    () => {
      projectListCalls += 1
      return ['[dir] src']
    },
  )

  await sources.refreshSessions()
  assert.equal(sources.snapshot().sessionStatus, 'empty')
  assert.deepEqual(sources.snapshot().sessions, [])

  sources.ensureProjectRoot('/repo')
  sources.ensureProjectRoot('/repo')
  assert.equal(projectListCalls, 1)
  assert.deepEqual(sources.snapshot().projectRows[0]?.command, {
    kind: 'project.toggle',
    root: '/repo/src',
  })

  const failing = new ShellSources(async () => {
    throw new Error('index unavailable')
  })
  await failing.refreshSessions()
  assert.equal(failing.snapshot().sessionStatus, 'error')
  assert.equal(failing.snapshot().sessionError, 'index unavailable')
  assert.deepEqual(failing.snapshot().sessions, [])
})
