import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveSessionExecutionProfile, workerThreadCompatible } from '../native/session-profile.mjs'

test('a legacy session without a record keeps the proven Docker boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-profile-'))
  try {
    mkdirSync(join(root, 'chat-legacy'), { recursive: true })
    assert.deepEqual(resolveSessionExecutionProfile('chat-legacy', { sessionsDir: root }), { profile: 'safe_repo', recorded: false })
    assert.deepEqual(resolveSessionExecutionProfile(undefined, { sessionsDir: root }), { profile: 'host_native', recorded: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the resident worker is used only for a matching thread descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-descriptor-'))
  try {
    const dir = join(root, 'chat-worker')
    mkdirSync(dir, { recursive: true })
    const descriptor = { schemaVersion: 1, threadId: 'chat-worker', mode: 'chat', projectRoot: root, provider: 'openrouter', model: 'fixture-model', policyProfile: 'host_native' }
    writeFileSync(join(dir, 'session-descriptor.json'), JSON.stringify(descriptor))
    const options = { sessionsDir: root, provider: 'openrouter', model: 'fixture-model', profile: 'host_native' }
    assert.equal(workerThreadCompatible('chat-worker', options), true)
    assert.equal(workerThreadCompatible('chat-worker', { ...options, model: 'another-model' }), false)
    assert.equal(workerThreadCompatible('chat-worker', { ...options, provider: 'deepseek' }), false)
    assert.equal(workerThreadCompatible('chat-worker', { ...options, profile: 'safe_repo' }), false)
    writeFileSync(join(dir, 'session-descriptor.json'), JSON.stringify({ ...descriptor, harness_adapter_id: 'command-code' }))
    assert.equal(workerThreadCompatible('chat-worker', options), false)
    assert.equal(workerThreadCompatible('chat-missing', options), false)
    assert.equal(workerThreadCompatible(undefined, options), true)
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
    writeFileSync(join(docker, 'execution-policy.json'), JSON.stringify({ version: 1, profile: 'safe_repo', source: 'explicit', effectiveBoundary: 'docker' }))
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
