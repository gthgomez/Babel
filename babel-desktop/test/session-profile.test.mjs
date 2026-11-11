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
    assert.equal(resolveSessionExecutionProfile('chat-legacy', { sessionsDir: root }), 'safe_repo')
    assert.equal(resolveSessionExecutionProfile(undefined, { sessionsDir: root }), 'host_native')
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
    assert.equal(resolveSessionExecutionProfile('chat-host', { sessionsDir: root }), 'host_native')
    assert.equal(resolveSessionExecutionProfile('chat-docker', { sessionsDir: root }), 'safe_repo')
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
