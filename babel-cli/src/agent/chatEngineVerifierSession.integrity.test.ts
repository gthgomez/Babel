import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { checkVerifierTamper, initializeVerifierDependencyHashes } from './chatEngineVerifierSession.js'

test('task-authored direct Node test verifier files are integrity tracked with spaced paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-input-integrity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test files'), { recursive: true })
  const testPath = join(root, 'test files', 'parser.test.mjs')
  writeFileSync(testPath, 'assert.equal(1, 1)\n')
  const hashes = new Map<string, string>()
  initializeVerifierDependencyHashes(undefined, root, hashes, ['node --test "test files/parser.test.mjs"'])
  assert.ok(hashes.has('test files/parser.test.mjs'))

  writeFileSync(testPath, 'assert.equal(2, 2)\n')
  const state = { verifierDependencyHashes: hashes, verifierTampered: false, tamperCount: 0, tamperedThisTurn: false }
  assert.match(checkVerifierTamper(testPath, root, state) ?? '', /dependency of the verifier command/i)
  assert.equal(state.verifierTampered, true)
})

test('direct Node test verifier inputs without conventional suffixes are integrity tracked', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-unsuffixed-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const testPath = join(root, 'scripts', 'parser-regression')
  writeFileSync(testPath, 'assert.equal(parseSum(2, 3), 5)\n')
  const hashes = new Map<string, string>()
  initializeVerifierDependencyHashes(undefined, root, hashes, ['node --test scripts/parser-regression'])
  assert.ok(hashes.has('scripts/parser-regression'))
})
