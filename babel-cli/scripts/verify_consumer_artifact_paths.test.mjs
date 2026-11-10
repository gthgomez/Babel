// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'verify_consumer_artifact.mjs'), 'utf8')

test('Windows consumer install uses ASCII npm --prefix while retaining Unicode env qualification', () => {
  assert.match(script, /isWin \? 'babel-consumer-' : 'babel consumer é-'/)
  assert.match(script, /isWin \? 'install-prefix' : 'install prefix é'/)
  assert.match(script, /prefix_encoding_policy/)
  const envScript = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'consumer_environment.mjs'), 'utf8')
  assert.match(envScript, /config area ü/)
})
