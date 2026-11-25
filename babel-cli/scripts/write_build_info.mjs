// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function readBuildGit(root, args) {
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

function readBuildInput(path, maxBytes) {
  try {
    const expected = lstatSync(path, { bigint: true })
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || expected.size > BigInt(maxBytes)) return null
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
      return bytes.subarray(0, offset)
    } finally { closeSync(fd) }
  } catch { return null }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const compilerPackagePath = 'node_modules/typescript/package.json'
const buildInputs = [
  ['package.json', 1024 * 1024],
  ['package-lock.json', 16 * 1024 * 1024],
  ['tsconfig.json', 1024 * 1024],
  [compilerPackagePath, 64 * 1024],
  ['node_modules/typescript/bin/tsc', 64 * 1024],
  ['node_modules/typescript/lib/tsc.js', 16 * 1024 * 1024],
  ['node_modules/typescript/lib/_tsc.js', 16 * 1024 * 1024],
]

/**
 * A bounded, versioned digest of named CLI inputs, not a reproducible-build
 * attestation. The source tree is bound separately; npm's installed dependency
 * bytes, other compiler files, the Node binary, flags and host remain uncovered.
 */
export function captureRecordedBuildInputs(packageRoot) {
  const files = []
  for (const [path, limit] of buildInputs) {
    const bytes = readBuildInput(join(packageRoot, path), limit)
    if (bytes === null) return null
    files.push([path, sha256(bytes)])
  }
  const scope = 'cli-manifest-lock-config-and-tsc-files:v1'
  return {
    scope,
    sha256: sha256(JSON.stringify([scope, process.versions.node, files])),
    packageLockSha256: files[1][1],
  }
}

export function assertRecordedBuildInputs(value, expected) {
  const digest = /^[a-f0-9]{64}$/
  if (value?.scope !== 'cli-manifest-lock-config-and-tsc-files:v1' ||
      !digest.test(value.sha256) || !digest.test(value.packageLockSha256) ||
      value.sha256 !== expected?.sha256 || value.packageLockSha256 !== expected?.packageLockSha256 ||
      value.scope !== expected?.scope) {
    throw new Error('Recorded CLI build inputs do not match the expected receipt')
  }
}

export function inspectBuildSource(root) {
  const trackedPackage = readBuildGit(root, ['ls-files', '--error-unmatch', '--', 'package.json'])
  const commit = trackedPackage === null ? null : readBuildGit(root, ['rev-parse', '--verify', 'HEAD'])
  const tree = commit === null ? null : readBuildGit(root, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const status = commit === null ? null : readBuildGit(root, ['status', '--porcelain=v1', '--untracked-files=normal'])
  const validObject = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
  return {
    sourceCommit: validObject(commit) ? commit : null,
    sourceTree: validObject(tree) ? tree : null,
    workingTreeClean: status === null ? null : status.length === 0,
  }
}

/** Self-reported build metadata; the external archive receipt remains authoritative. */
export function createBuildInfo(packageRoot) {
  const root = resolve(packageRoot)
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (typeof packageVersion !== 'string' || !packageVersion) throw new Error('Package version is missing')
  const compilerPackage = readBuildInput(join(root, compilerPackagePath), 64 * 1024)
  let typescriptVersion = null
  try {
    const version = compilerPackage && JSON.parse(compilerPackage.toString('utf8')).version
    if (typeof version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(version)) typescriptVersion = version
  } catch { /* Compiler version remains unknown. */ }
  return {
    schemaVersion: 1,
    packageVersion,
    ...inspectBuildSource(root),
    buildInputsDigest: null,
    buildInputsReason: 'complete build inputs were not recorded',
    recordedBuildInputs: captureRecordedBuildInputs(root),
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
  check(info.buildInputsDigest === null && info.buildInputsReason === 'complete build inputs were not recorded',
    'Build identity must not claim complete input coverage')
  assertRecordedBuildInputs(info.recordedBuildInputs, expected.recordedBuildInputs)
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
