// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('babel-cli/package.json', root), 'utf8'))
const selection = 'src/daemon/backgroundJsonFraming.test.ts'
const unitTokens = pkg.scripts['test:unit'].trim().split(/\s+/)
const testChain = pkg.scripts.test.split('&&').map(step => step.trim())

test('W11 daemon JSON framing regression is selected by the required unit lane', () => {
  // `npm test` is local-only; hosted CI invokes the unit shards, so the
  // regression must be in the canonical test:unit selection to gate merges.
  assert.equal(unitTokens.filter(token => token === selection).length, 1)
  assert.ok(unitTokens.includes('src/daemon/diagnosticStream.test.ts'))
  assert.ok(unitTokens.includes('src/daemon/pipelineQualification.test.ts'))
})

test('local-only daemon lane is not broadened into the npm test chain', () => {
  // test:daemon owns daemon IPC files with documented Windows exclusions; the
  // hosted unit lane runs only the explicitly vetted daemon files above.
  assert.equal(testChain.includes('npm run test:daemon'), false)
  assert.equal(pkg.scripts['test:daemon'].includes('src/daemon/**/*.test.ts'), true)
})

test('selected regression source exists and is non-empty', () => {
  const file = new URL('babel-cli/' + selection, root)
  assert.ok(existsSync(file), 'PR #539 must merge first; this branch intentionally selects the post-#539 file')
  assert.ok(statSync(file).size > 0, 'selected regression file must not be empty')
})
