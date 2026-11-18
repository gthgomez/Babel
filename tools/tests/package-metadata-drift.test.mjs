import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('babel-cli package.json version and bin aliases match the lock root', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../babel-cli/package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../../babel-cli/package-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.packages[''].version, pkg.version)
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['babel', 'babel-agent', 'babel-harness'])
  assert.deepEqual(lock.packages[''].bin, pkg.bin, 'lock root bin metadata must match the package manifest')
})

test('install guidance names every installed alias without claiming babel is absent', () => {
  const readme = readFileSync(new URL('../../babel-cli/README.md', import.meta.url), 'utf8')
  assert.match(readme, /aliases; the\s+help output reports the alias you invoked/)
  for (const alias of ['babel-harness', 'babel-agent', '`babel`']) assert.ok(readme.includes(alias), alias)
  assert.doesNotMatch(readme, /These names\s+avoid the unrelated BabelJS `babel` executable/)
})
