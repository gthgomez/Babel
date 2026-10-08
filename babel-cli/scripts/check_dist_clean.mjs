// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name), relative = prefix + entry.name
    if (entry.isDirectory()) return ['__snapshots__', 'testinfra'].includes(entry.name) ? [] : inventory(path, relative + '/')
    if (/\.test\.[cm]?js$|\.map$|\.d\.[cm]?ts$|\.tsbuildinfo$/.test(entry.name)) return []
    assert.ok(entry.isFile(), 'Unexpected dist file type')
    return [[relative, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  })
}

/** Compare the distributed output bytes before and after a source rebuild, including ignored files. */
export function checkDistContents(directory, rebuild) {
  const before = inventory(directory)
  assert.ok(before.length, 'Build dist before checking content drift')
  rebuild()
  assert.deepEqual(inventory(directory), before, 'Generated dist content drifted from source')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'Run with npm run check:dist')
  try {
    checkDistContents(join(root, 'dist'), () => execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
