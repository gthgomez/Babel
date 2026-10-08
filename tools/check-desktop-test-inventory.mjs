// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function checkDesktopInventory(root = new URL('../babel-desktop/', import.meta.url)) {
const expected = ['bundle.test.mjs', 'core.test.mjs', 'diagnostics.test.mjs',
  'installed-runtime.test.mjs', 'native.test.mjs', 'package-windows-setup.test.mjs']
const files = readdirSync(new URL('test/', root)).filter(p => p.endsWith('.test.mjs')).sort()
for (const name of expected) assert.ok(files.includes(name), `Desktop regression missing: ${name}`)
const pkg = JSON.parse(readFileSync(new URL('package.json', root)))
assert.equal(pkg.scripts.test, 'node scripts/build.mjs && node --test test/*.test.mjs')
return { suite: 'desktop', files: files.map(p => 'test/' + p), package: 'babel-desktop' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkDesktopInventory()))
