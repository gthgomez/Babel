import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('babel-cli package.json version matches lock root and both bin aliases', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../babel-cli/package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../../babel-cli/package-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.packages[''].version, pkg.version)
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['babel-agent', 'babel-harness'])
})
