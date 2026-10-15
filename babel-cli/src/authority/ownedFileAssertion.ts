import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCredentialTargetPath } from './protectedPath.js'

export interface OwnedFileAssertionV1 {
  readonly schema_version: 1
  readonly kind: 'owned_file_assertion_v1'
  readonly candidate_path: string
  readonly operation: 'utf8_equals'
  readonly expected: string
}
export interface OwnedFileAssertionResultV1 {
  readonly schema_version: 1
  readonly status: 'passed' | 'failed' | 'unsupported'
  readonly reason_code: string
  readonly candidate_sha256?: string
}
const MAX_EXPECTED_BYTES = 32768
const MAX_CANDIDATE_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const FIELDS = ['schema_version', 'kind', 'candidate_path', 'operation', 'expected']

function validCandidatePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || isCredentialTargetPath(value)) return false
  return value.split('/').every(part => part.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

/** Parse data only: a manifest neither grants execution nor certifies a criterion. */
export function parseOwnedFileAssertionV1(value: unknown): OwnedFileAssertionV1 {
  const invalid = () => new Error('OWNED_ASSERTION_MANIFEST_INVALID')
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid()
  if (Object.keys(value).length !== FIELDS.length || FIELDS.some(field =>
    !Object.hasOwn(value, field) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, field)!, 'value'))) throw invalid()
  const input = value as Record<string, unknown>
  if (input['schema_version'] !== 1 || input['kind'] !== 'owned_file_assertion_v1' ||
    input['operation'] !== 'utf8_equals' || !validCandidatePath(input['candidate_path']) ||
    typeof input['expected'] !== 'string' || Buffer.byteLength(input['expected'], 'utf8') > MAX_EXPECTED_BYTES ||
    Buffer.from(input['expected'], 'utf8').toString('utf8') !== input['expected']) throw invalid()
  return Object.freeze({ schema_version: 1, kind: 'owned_file_assertion_v1',
    candidate_path: input['candidate_path'], operation: 'utf8_equals', expected: input['expected'] })
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
}
function sameFile(before: Stats, after: Stats): boolean {
  return sameIdentity(before, after) && before.size === after.size &&
    before.nlink === after.nlink && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}
function forbiddenRoot(root: string): boolean {
  return isCredentialTargetPath(root) || root.replace(/\\/g, '/').split('/').some(part =>
    ['.codex', '.ssh', '.aws', '.azure', '.git', '.config', '.gnupg', '.kube', '.docker'].includes(part.toLowerCase()))
}

/** Admit metadata first, then read a single bounded, physically stable regular file. */
function readOwnedData(rootInput: string, relativePath: string, maxBytes: number): Buffer {
  const unsupported = () => new Error('OWNED_ASSERTION_INPUT_UNSUPPORTED')
  if (!isAbsolute(rootInput) || forbiddenRoot(rootInput) || !validCandidatePath(relativePath)) throw unsupported()
  const root = realpathSync.native(rootInput)
  if (forbiddenRoot(root)) throw unsupported()
  const parents: Array<{ path: string; stat: Stats }> = []
  const parts = relativePath.split('/')
  let directory = root
  for (const part of ['.', ...parts.slice(0, -1)]) {
    directory = join(directory, part)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsupported()
    parents.push({ path: directory, stat })
  }
  const absolute = join(root, relativePath)
  const admitted = lstatSync(absolute)
  if (!admitted.isFile() || admitted.isSymbolicLink() || admitted.nlink !== 1 ||
    admitted.size > maxBytes || admitted.size < 0) throw unsupported()
  // Metadata checks precede content access even when O_NOFOLLOW is unavailable.
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || !sameFile(admitted, before)) throw unsupported()
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length)
      if (!read) break
      length += read
    }
    if (length !== before.size || !sameFile(before, fstatSync(descriptor)) ||
      !sameFile(before, lstatSync(absolute)) || realpathSync.native(rootInput) !== root ||
      parents.some(parent => !sameIdentity(parent.stat, lstatSync(parent.path)))) throw unsupported()
    return buffer.subarray(0, length)
  } finally { closeSync(descriptor) }
}

function result(status: OwnedFileAssertionResultV1['status'], reason_code: string,
  candidate_sha256?: string): OwnedFileAssertionResultV1 {
  return Object.freeze({ schema_version: 1, status, reason_code,
    ...(candidate_sha256 ? { candidate_sha256 } : {}) })
}

/** A subordinate data-oracle result; trusted governance/evidence ownership is separate. */
export function evaluateOwnedFileAssertionV1(projectRoot: string, value: unknown): OwnedFileAssertionResultV1 {
  let manifest: OwnedFileAssertionV1
  try { manifest = parseOwnedFileAssertionV1(value) }
  catch { return result('unsupported', 'manifest_invalid') }
  let content: Buffer
  try { content = readOwnedData(projectRoot, manifest.candidate_path, MAX_CANDIDATE_BYTES) }
  catch { return result('unsupported', 'candidate_unsupported') }
  try { new TextDecoder('utf-8', { fatal: true }).decode(content) }
  catch { return result('unsupported', 'candidate_not_utf8') }
  const matched = content.equals(Buffer.from(manifest.expected, 'utf8'))
  return result(matched ? 'passed' : 'failed', matched ? 'literal_matched' : 'literal_mismatch',
    createHash('sha256').update(content).digest('hex'))
}

/** Dedicated compiled runner entry; never opens arbitrary argument-selected stores. */
function runOwnedFileAssertion(): OwnedFileAssertionResultV1 {
  const [, , operation, projectRoot, manifestPath, manifestHash] = process.argv
  if (process.argv.length !== 6 || operation !== '--run' || !projectRoot || !manifestPath ||
    !isAbsolute(manifestPath) || !manifestHash || !/^[0-9a-f]{64}$/.test(manifestHash) ||
    basename(manifestPath) !== `owned-file-assertion-${manifestHash}.json`)
    return result('unsupported', 'manifest_invalid')
  try {
    const bytes = readOwnedData(dirname(manifestPath), basename(manifestPath), MAX_MANIFEST_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== manifestHash)
      return result('unsupported', 'manifest_hash_mismatch')
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    return evaluateOwnedFileAssertionV1(projectRoot, manifest)
  } catch { return result('unsupported', 'manifest_unavailable') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = runOwnedFileAssertion()
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
  process.exitCode = outcome.status === 'passed' ? 0 : outcome.status === 'failed' ? 1 : 2
}
