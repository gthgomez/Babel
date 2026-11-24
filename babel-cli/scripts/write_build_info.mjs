// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function git(root, args) {
  // Ambient Git routing or injected config must not make another repository
  // look like the source tree. These commands are read-only and must not
  // opportunistically refresh the user's index.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key]
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env,
  })
  return result.status === 0 && !result.error ? result.stdout.trim() : null
}

function readCompilerVersion(root) {
  try {
    const path = join(root, 'node_modules', 'typescript', 'package.json')
    const expected = lstatSync(path, { bigint: true })
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || expected.size > 64n * 1024n) return null
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const actual = fstatSync(fd, { bigint: true })
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
          actual.nlink !== 1n || actual.size !== expected.size) return null
      const bytes = Buffer.alloc(Number(actual.size) + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (!count) break
        offset += count
      }
      if (offset !== Number(actual.size)) return null
      const version = JSON.parse(bytes.subarray(0, offset).toString('utf8')).version
      return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : null
    } finally { closeSync(fd) }
  } catch { return null }
}

/** Self-reported build metadata; the external archive receipt remains authoritative. */
export function createBuildInfo(packageRoot) {
  const root = resolve(packageRoot)
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (typeof packageVersion !== 'string' || !packageVersion) throw new Error('Package version is missing')
  const typescriptVersion = readCompilerVersion(root)
  const trackedPackage = git(root, ['ls-files', '--error-unmatch', '--', 'package.json'])
  const commit = trackedPackage === null ? null : git(root, ['rev-parse', '--verify', 'HEAD'])
  const tree = commit === null ? null : git(root, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const status = commit === null ? null : git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])
  const validObject = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
  return {
    schemaVersion: 1,
    packageVersion,
    sourceCommit: validObject(commit) ? commit : null,
    sourceTree: validObject(tree) ? tree : null,
    workingTreeClean: status === null ? null : status.length === 0,
    buildInputsDigest: null,
    buildInputsReason: 'complete build inputs were not recorded',
    nodeVersion: process.versions.node,
    typescriptVersion,
  }
}

/** A release may bind this self-report only after comparing it to the clean candidate. */
export function assertReleaseBuildInfo(info, expected) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const objectId = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
  check(Boolean(info && typeof info === 'object' && !Array.isArray(info)), 'Build identity is missing')
  check(info.schemaVersion === 1, 'Unsupported build identity schema')
  check(typeof expected.packageVersion === 'string' && info.packageVersion === expected.packageVersion, 'Build identity version does not match the package')
  check(objectId(expected.sourceCommit) && info.sourceCommit === expected.sourceCommit, 'Build identity commit does not match the candidate')
  check(objectId(expected.sourceTree) && info.sourceTree === expected.sourceTree, 'Build identity tree does not match the candidate')
  check(info.workingTreeClean === true, 'Release build identity must report a clean source tree')
  check(typeof info.nodeVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(info.nodeVersion), 'Build Node version is unavailable')
  check(typeof info.typescriptVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(info.typescriptVersion), 'Build compiler version is unavailable')
}

export function writeBuildInfo(packageRoot) {
  const info = createBuildInfo(packageRoot)
  writeFileSync(join(packageRoot, 'dist', 'cli', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

const ownPath = fileURLToPath(import.meta.url)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeBuildInfo(resolve(dirname(ownPath), '..'))
}
