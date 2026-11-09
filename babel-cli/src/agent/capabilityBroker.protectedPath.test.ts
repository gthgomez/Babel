import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesProtectedPath } from './capabilityBroker.js'

test('protected verifier paths use Windows case-insensitive identity and separator rules', () => {
  assert.equal(matchesProtectedPath('TEST\\PARSER.TEST.MJS', 'test/parser.test.mjs', false), true)
  assert.equal(matchesProtectedPath('test/parser.test.mjs', 'TEST\\PARSER.TEST.MJS', false), true)
  assert.equal(matchesProtectedPath('test/parser.test.mjs', 'test/parser.test.mjs', true), true)
  assert.equal(matchesProtectedPath('test/PARSER.test.mjs', 'test/parser.test.mjs', true), false)
})

test('protected directory and wildcard matching keeps path boundaries', () => {
  assert.equal(matchesProtectedPath('test/parser.test.mjs', 'test'), true)
  assert.equal(matchesProtectedPath('test/parser.test.mjs/child', 'test/parser.test.mjs'), true)
  assert.equal(matchesProtectedPath('test-other/parser.test.mjs', 'test'), false)
  assert.equal(matchesProtectedPath('test/parser.test.mjs', 'test/**'), true)
  assert.equal(matchesProtectedPath('testing/parser.test.mjs', 'test/**'), false)
})
