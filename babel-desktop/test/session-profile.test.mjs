import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveSessionExecutionProfile } from '../native/session-profile.mjs'

test('a legacy session without a record keeps the proven Docker boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-profile-'))
  try {
    mkdirSync(join(root, 'chat-legacy'), { recursive: true })
    assert.deepEqual(resolveSessionExecutionProfile('chat-legacy', { sessionsDir: root }), { profile: 'safe_repo', recorded: false })
    assert.deepEqual(resolveSessionExecutionProfile(undefined, { sessionsDir: root }), { profile: 'host_native', recorded: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a recorded boundary is restored and corruption fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-profile-'))
  try {
    const host = join(root, 'chat-host')
    const docker = join(root, 'chat-docker')
    const broken = join(root, 'chat-broken')
    for (const dir of [host, docker, broken]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(host, 'execution-policy.json'), JSON.stringify({ version: 1, profile: 'host_native', source: 'explicit', effectiveBoundary: 'host' }))
    writeFileSync(join(docker, 'execution-policy.json'), JSON.stringify({ version: 1, profile: 'safe_repo', source: 'persisted', effectiveBoundary: 'docker' }))
    assert.deepEqual(resolveSessionExecutionProfile('chat-host', { sessionsDir: root }), { profile: 'host_native', recorded: true })
    assert.deepEqual(resolveSessionExecutionProfile('chat-docker', { sessionsDir: root }), { profile: 'safe_repo', recorded: true })
    for (const bad of [
      '{broken',
      JSON.stringify({ version: 1, profile: 'host_native', source: 'explicit', effectiveBoundary: 'docker' }),
      JSON.stringify({ version: 1, profile: 'safe_repo', source: 'explicit', effectiveBoundary: 'host' }),
      JSON.stringify({ version: 2, profile: 'host_native', source: 'explicit', effectiveBoundary: 'host' }),
    ]) {
      writeFileSync(join(broken, 'execution-policy.json'), bad)
      assert.throws(() => resolveSessionExecutionProfile('chat-broken', { sessionsDir: root }), /invalid/i)
    }
    assert.throws(() => resolveSessionExecutionProfile('../escape', { sessionsDir: root }), /invalid chat session/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
