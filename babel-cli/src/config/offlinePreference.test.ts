import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readUserSettings, updateUserSettings } from './userSettings.js'

const path = join(mkdtempSync(join(tmpdir(), 'babel-pref-ollama-')), 'preferences.json')

test('a loopback Ollama base URL is a valid local preference', () => {
  for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) {
    const settings = updateUserSettings({
      connections: { local: { id: 'local', provider: 'ollama', model: 'llama3:8b', baseUrl } },
    }, { path })
    assert.equal(settings.connections.local?.baseUrl, baseUrl)
    assert.equal(readUserSettings({ path }).connections.local?.provider, 'ollama')
  }
})

test('a remote Ollama endpoint is rejected with a specific, value-free reason', () => {
  assert.throws(
    () => updateUserSettings({
      connections: { local: { id: 'local', provider: 'ollama', model: 'llama3:8b', baseUrl: 'https://remote.example.test/v1' } },
    }, { path }),
    (error: Error) => {
      assert.match(error.message, /connections\.local\.baseUrl/)
      assert.match(error.message, /must be loopback HTTP/)
      assert.doesNotMatch(error.message, /remote\.example\.test/)
      return true
    },
  )
  assert.equal(readUserSettings({ path }).connections.local?.baseUrl !== undefined, true)
})

test('invalid preference updates name the failing field instead of a generic error', () => {
  assert.throws(
    () => updateUserSettings({
      connections: { broken: { id: 'broken', provider: 'openai-compatible', model: 'fixture' } },
    }, { path }),
    /connections\.broken: Custom compatible connections require a base URL/,
  )
})

test('a credentialed provider still may not supply a project-visible endpoint', () => {
  assert.throws(
    () => updateUserSettings({
      connections: { fixed: { id: 'fixed', provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' } },
    }, { path }),
    /This provider pins its endpoint/,
  )
})
