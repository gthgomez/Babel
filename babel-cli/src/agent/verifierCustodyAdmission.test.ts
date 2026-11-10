import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeVerifierCustodyKey,
  pathUnderVerifierCustody,
  recordVerifierCustodyViolation,
} from './verifierCustodyAdmission.js'

test('custody keys normalize project-relative verifier inputs', () => {
  assert.equal(normalizeVerifierCustodyKey('./test/parser.test.mjs'), 'test/parser.test.mjs')
})

test('protected or hashed verifier inputs are under custody', () => {
  const hashes = new Map([['test/parser.test.mjs', 'abc']])
  assert.equal(pathUnderVerifierCustody('test/parser.test.mjs', hashes), true)
  assert.equal(pathUnderVerifierCustody('src/parser.js', hashes, ['.env']), false)
  assert.equal(pathUnderVerifierCustody('package.json', new Map(), ['package.json']), true)
})

test('recordVerifierCustodyViolation flips live tamper state', () => {
  const state = {
    verifierDependencyHashes: new Map([['test/a.mjs', '1']]),
    verifierTampered: false,
    tamperCount: 0,
    tamperedThisTurn: false,
  }
  recordVerifierCustodyViolation(state)
  assert.equal(state.verifierTampered, true)
  assert.equal(state.tamperCount, 1)
})
