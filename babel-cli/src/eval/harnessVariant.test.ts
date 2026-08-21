import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { harnessVariantChildEnv, resolveHarnessVariant } from './harnessVariant.js'
import { BABEL_ROOT } from '../cli/constants.js'

test('resolveHarnessVariant records repo_root as BABEL_ROOT', () => {
  const variant = resolveHarnessVariant({
    id: 'baseline',
    git_sha: 'deadbeef',
    repo_root: BABEL_ROOT,
  })
  assert.equal(variant.environment.BABEL_ROOT, BABEL_ROOT)
  assert.ok(variant.build_identity.source_tree_hash.length === 64)
  assert.ok(variant.cli_entry.includes('babel-cli'))
})

test('harnessVariantChildEnv does not inherit a parent BABEL_ROOT override', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hv-'))
  mkdirSync(join(root, 'babel-cli', 'dist'), { recursive: true })
  writeFileSync(join(root, 'babel-cli', 'dist', 'index.js'), 'export {}\n')
  mkdirSync(join(root, 'babel-cli', 'src'), { recursive: true })
  writeFileSync(join(root, 'babel-cli', 'src', 'x.ts'), 'export {}\n')
  const variant = resolveHarnessVariant({
    id: 'candidate',
    git_sha: 'abc',
    repo_root: root,
    cli_entry: join(root, 'babel-cli', 'dist', 'index.js'),
  })
  const env = harnessVariantChildEnv(variant, { BABEL_ROOT: '/wrong/parent' })
  assert.equal(env['BABEL_ROOT'], root)
})
