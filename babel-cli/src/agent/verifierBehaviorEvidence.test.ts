import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertionEvidenceMatches } from './verifierBehaviorEvidence.js'

const call = /\bparseSum\s*\(\s*2\s*,\s*3\s*\)/
const testBody = (body: string): string => [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { parseSum } from '../parser.js'",
  '',
  "test('parseSum', () => {",
  body,
  '})',
  '',
].join('\n')

test('a direct live assertion is behavioral evidence', () => {
  assert.equal(assertionEvidenceMatches(testBody('  assert.equal(parseSum(2, 3), 5)'), call, '5'), true)
})

test('an assertion after an unconditional return is not evidence', () => {
  assert.equal(
    assertionEvidenceMatches(testBody('  return\n  assert.equal(parseSum(2, 3), 5)'), call, '5'),
    false,
  )
})

test('a swallowed assertion is not evidence', () => {
  assert.equal(
    assertionEvidenceMatches(testBody('  try {\n    assert.equal(parseSum(2, 3), 5)\n  } catch {}'), call, '5'),
    false,
  )
})

test('a rethrowing or failing catch propagates the assertion', () => {
  assert.equal(
    assertionEvidenceMatches(
      testBody('  try {\n    assert.equal(parseSum(2, 3), 5)\n  } catch (error) { throw error }'),
      call,
      '5',
    ),
    true,
  )
  assert.equal(
    assertionEvidenceMatches(
      testBody('  try {\n    assert.equal(parseSum(2, 3), 5)\n  } catch { assert.ok(false) }'),
      call,
      '5',
    ),
    true,
  )
})

test('a discarded comma-sequence result is not evidence', () => {
  assert.equal(
    assertionEvidenceMatches(testBody('  assert.equal((parseSum(2, 3), 5), 5)'), call, '5'),
    false,
  )
})

test('a skipped registration is not evidence', () => {
  const content = [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { parseSum } from '../parser.js'",
    '',
    "test.skip('parseSum', () => {",
    '  assert.equal(parseSum(2, 3), 5)',
    '})',
    '',
  ].join('\n')
  assert.equal(assertionEvidenceMatches(content, call, '5'), false)
})

test('a required symbol must be the observed operand', () => {
  const content = testBody('  assert.equal(value, 2)')
  assert.equal(assertionEvidenceMatches(content, null, '2', { requiredSymbols: ['value'] }), true)
  assert.equal(assertionEvidenceMatches(content, null, '3', { requiredSymbols: ['value'] }), false)
  assert.equal(assertionEvidenceMatches(content, null, '2', { requiredSymbols: ['other'] }), false)
})
