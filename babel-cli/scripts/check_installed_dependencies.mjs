// License: Apache-2.0 — see LICENSE
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Detect drift without reinstalling or executing package code. Optional omissions follow npm semantics. */
export function checkInstalledDependencies(root) {
  const bytes = readFileSync(join(root, 'package-lock.json'))
  const lock = JSON.parse(bytes)
  if (!lock.packages || lock.lockfileVersion < 2) throw new Error('unsupported dependency lock')
  const problems = []
  let checked = 0
  for (const [path, expected] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || expected.link) continue
    if (path.split('/').some(part => part === '..' || part === '.') || path.includes('\\')) throw new Error('unsafe dependency lock path')
    let installed
    try { installed = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT' && expected.optional) continue
      problems.push({ path, reason: error.code === 'ENOENT' ? 'missing' : 'invalid-package-metadata' })
      continue
    }
    checked++
    if (typeof expected.version !== 'string' || installed.version !== expected.version) problems.push({ path, reason: 'version-drift' })
  }
  return { status: problems.length ? 'FAIL' : 'PASS', nodeVersion: process.version,
    lockSha256: createHash('sha256').update(bytes).digest('hex'), checked, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkInstalledDependencies(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    console.log(JSON.stringify(result))
    if (result.status !== 'PASS') process.exitCode = 1
  } catch { console.error('Dependency consistency unavailable'); process.exitCode = 1 }
}
