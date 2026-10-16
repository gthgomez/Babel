import { resolve } from 'node:path'
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

// Fail closed for a stale caller of the removed evaluator. Never inspect its
// arguments, open project/manifest files or silently select another backend.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('{"schema_version":1,"status":"unsupported","reason_code":"node_oracle_retired"}\n')
  process.exitCode = 2
}
