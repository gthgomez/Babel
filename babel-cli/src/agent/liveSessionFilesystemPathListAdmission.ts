/**
 * Admission-only trusted host filesystem path-list binding for live sessions.
 * Inspection/persistence only — not completion authority.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  captureFilesystemSourceBaseline,
  type FilesystemSourceBaselineV1,
} from '../authority/filesystemPathListVerifier.js'
import {
  declarationContentHash,
  parseTrustedHostFilesystemPathListDeclaration,
  type TrustedHostFilesystemPathListDeclarationV1,
} from '../authority/trustedHostFilesystemPathList.js'
import type { TaskContractV1 } from './taskContract.js'
import { LiveSessionAuthorityError } from './liveSessionAuthorityError.js'

export const TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME =
  'trusted-host-filesystem-path-list-admission.json'

export const TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX =
  'trusted-host-filesystem-path-list-admission:v1#'

/** @deprecated use pathListAdmissionProvenanceRef */
export const TRUSTED_HOST_PATH_LIST_ADMISSION_REF =
  'trusted-host-filesystem-path-list-admission:v1'

export const LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND =
  'live_session_filesystem_path_list_admission_v1' as const

export interface LiveSessionFilesystemPathListAdmissionV1 {
  readonly schema_version: 1
  readonly kind: typeof LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND
  readonly declaration: TrustedHostFilesystemPathListDeclarationV1
  readonly user_request_digest: string
  readonly project_root_real: string
  readonly preserved_baseline: FilesystemSourceBaselineV1
  readonly admission_record_digest: string
}

let pathListBaselineCaptureCount = 0

/** Test-only: count baseline capture invocations for admission. */
export function resetPathListBaselineCaptureCountForTests(): void {
  pathListBaselineCaptureCount = 0
}

export function pathListBaselineCaptureCountForTests(): number {
  return pathListBaselineCaptureCount
}

/** Freeze nested admission data even when stage-1 parents are already shallow-frozen. */
export function deepFreezeAdmissionRecord<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeAdmissionRecord(child)
  }
  if (!Object.isFrozen(value)) Object.freeze(value)
  return value
}

export function pathListAdmissionProvenanceRef(admissionRecordDigest: string): string {
  if (!/^[0-9a-f]{64}$/i.test(admissionRecordDigest)) {
    throw new Error('PATH_LIST_ADMISSION_INTERNAL: invalid admission record digest')
  }
  return `${TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX}${admissionRecordDigest.toLowerCase()}`
}

export function pathListAdmissionProvenanceRecord(admissionRecordDigest: string): {
  kind: 'repository_policy'
  ref: string
} {
  return { kind: 'repository_policy', ref: pathListAdmissionProvenanceRef(admissionRecordDigest) }
}

export function findPathListAdmissionProvenanceRecord(
  contract: TaskContractV1,
): { kind: string; ref: string } | undefined {
  return contract.provenance.records.find(record =>
    record.ref.startsWith(TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX) ||
    record.ref === TRUSTED_HOST_PATH_LIST_ADMISSION_REF,
  )
}

export function expectedAdmissionDigestFromContract(contract: TaskContractV1): string | undefined {
  const record = findPathListAdmissionProvenanceRecord(contract)
  if (!record) return undefined
  if (record.ref === TRUSTED_HOST_PATH_LIST_ADMISSION_REF) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_PROVENANCE_MISMATCH',
      'Path-list admission provenance is not bound to an admission record digest',
    )
  }
  if (!record.ref.startsWith(TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX)) return undefined
  const digest = record.ref.slice(TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX.length)
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_PROVENANCE_MISMATCH',
      'Path-list admission provenance digest is malformed',
    )
  }
  return digest.toLowerCase()
}

export function taskContractBindsPathListAdmission(contract: TaskContractV1): boolean {
  return findPathListAdmissionProvenanceRecord(contract) !== undefined
}

type AdmissionBody = Omit<LiveSessionFilesystemPathListAdmissionV1, 'admission_record_digest'>

function admissionRecordDigest(body: AdmissionBody): string {
  return sha256Canonical(body)
}

function sealAdmissionRecord(body: AdmissionBody): LiveSessionFilesystemPathListAdmissionV1 {
  const admission_record_digest = admissionRecordDigest(body)
  return deepFreezeAdmissionRecord({ ...body, admission_record_digest })
}

function sessionProjectRootReal(projectRoot: string): string {
  return realpathSync.native(projectRoot)
}

function hashFileAtProjectRoot(projectRootReal: string, relPath: string): string {
  const absolute = join(projectRootReal, relPath)
  return createHash('sha256').update(readFileSync(absolute)).digest('hex')
}

/** Verify preserved inputs still exist and match the admitted baseline (no recapture). */
export function assertPathListAdmissionPreservedInputsIntact(
  projectRoot: string,
  admission: LiveSessionFilesystemPathListAdmissionV1,
): void {
  const rootReal = sessionProjectRootReal(projectRoot)
  if (rootReal !== admission.project_root_real) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_SESSION_ROOT_MISMATCH',
      'Session project root does not match path-list admission project_root_real',
    )
  }
  for (const [relPath, snapshot] of Object.entries(admission.preserved_baseline.preserved)) {
    const absolute = join(rootReal, relPath)
    if (!existsSync(absolute)) {
      throw new LiveSessionAuthorityError(
        'PATH_LIST_PRESERVED_INPUT_MISSING',
        `Preserved path-list input is missing on disk: ${relPath}`,
      )
    }
    const currentHash = hashFileAtProjectRoot(rootReal, relPath)
    if (currentHash !== snapshot.content_sha256) {
      throw new LiveSessionAuthorityError(
        'PATH_LIST_PRESERVED_INPUT_DRIFT',
        `Preserved path-list input drifted on disk: ${relPath}`,
      )
    }
  }
}

function assertAdmissionMatchesContractProvenance(
  admission: LiveSessionFilesystemPathListAdmissionV1,
  contract: TaskContractV1,
): void {
  const expected = expectedAdmissionDigestFromContract(contract)
  if (!expected) return
  if (admission.admission_record_digest.toLowerCase() !== expected) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_PROVENANCE_MISMATCH',
      'Path-list admission sidecar digest does not match frozen contract provenance',
    )
  }
}

export function assertPathListSessionBinding(input: {
  projectRoot: string | null
  task: string
  contract: TaskContractV1
  admission?: LiveSessionFilesystemPathListAdmissionV1
  incomingDeclaration?: unknown
}): void {
  const binds = taskContractBindsPathListAdmission(input.contract)
  if (!binds && input.incomingDeclaration === undefined && !input.admission) return
  if (binds && !input.admission) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_MISSING',
      'Task contract binds path-list admission but no admission record is loaded',
    )
  }
  if (!input.admission) {
    if (input.incomingDeclaration !== undefined) return
    return
  }
  const admission = input.admission
  assertAdmissionMatchesContractProvenance(admission, input.contract)
  const taskDigest = sha256Canonical(input.task)
  if (taskDigest !== admission.user_request_digest || input.task !== admission.declaration.user_request) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_REQUEST_MISMATCH',
      'Task text does not match path-list admission binding',
    )
  }
  if (input.incomingDeclaration !== undefined) {
    assertPathListRefreshDeclarationCompatible(admission, input.incomingDeclaration)
  }
  if (input.projectRoot === null) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_DECLARATION_REQUIRES_PROJECT_ROOT',
      'PATH_LIST_DECLARATION_REQUIRES_PROJECT_ROOT: Path-list admission requires a non-null project root',
    )
  }
  assertPathListAdmissionPreservedInputsIntact(input.projectRoot, admission)
}

function parseAdmissionRecord(raw: unknown): LiveSessionFilesystemPathListAdmissionV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission record is not an object',
    )
  }
  const input = raw as Record<string, unknown>
  if (input['schema_version'] !== 1) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission schema_version is invalid',
    )
  }
  if (input['kind'] !== LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission kind is invalid',
    )
  }
  const declaration = parseTrustedHostFilesystemPathListDeclaration(input['declaration'])
  if (typeof input['user_request_digest'] !== 'string' || !/^[0-9a-f]{64}$/i.test(input['user_request_digest'])) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission user_request_digest is invalid',
    )
  }
  if (typeof input['project_root_real'] !== 'string' || !input['project_root_real'].trim()) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission project_root_real is invalid',
    )
  }
  const preserved_baseline = input['preserved_baseline']
  if (
    !preserved_baseline ||
    typeof preserved_baseline !== 'object' ||
    Array.isArray(preserved_baseline) ||
    (preserved_baseline as Record<string, unknown>)['kind'] !== 'filesystem_source_baseline_v1'
  ) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission preserved_baseline is invalid',
    )
  }
  const baseline = preserved_baseline as FilesystemSourceBaselineV1
  if (baseline.declaration_hash !== declarationContentHash(declaration)) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission declaration does not match preserved baseline',
    )
  }
  if (baseline.project_root_real !== input['project_root_real']) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission project root does not match preserved baseline',
    )
  }
  if (declaration.user_request_digest !== input['user_request_digest']) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission user_request_digest does not match declaration',
    )
  }
  const body: AdmissionBody = {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    declaration,
    user_request_digest: declaration.user_request_digest,
    project_root_real: String(input['project_root_real']),
    preserved_baseline: baseline,
  }
  const expectedDigest = admissionRecordDigest(body)
  if (
    typeof input['admission_record_digest'] !== 'string' ||
    input['admission_record_digest'].toLowerCase() !== expectedDigest
  ) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Filesystem path-list admission digest does not match record body',
    )
  }
  return sealAdmissionRecord(body)
}

function assertTaskMatchesAdmission(contract: TaskContractV1, admission: LiveSessionFilesystemPathListAdmissionV1): void {
  const taskDigest = sha256Canonical(contract.user_request)
  if (taskDigest !== admission.user_request_digest) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Task contract user_request does not match path-list admission binding',
    )
  }
  if (contract.user_request !== admission.declaration.user_request) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      'Task contract user_request text does not match path-list declaration',
    )
  }
}

/** Admit declaration against the live filesystem once; does not alter acceptance. */
export function admitFilesystemPathListForLiveSession(
  projectRoot: string,
  task: string,
  declarationInput: unknown,
): LiveSessionFilesystemPathListAdmissionV1 {
  const declaration = parseTrustedHostFilesystemPathListDeclaration(declarationInput)
  if (task !== declaration.user_request) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_REQUEST_MISMATCH',
      'Task text does not match trusted host filesystem path-list declaration user_request',
    )
  }
  pathListBaselineCaptureCount += 1
  const preserved_baseline = captureFilesystemSourceBaseline(projectRoot, declaration)
  const body: AdmissionBody = {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    declaration,
    user_request_digest: declaration.user_request_digest,
    project_root_real: preserved_baseline.project_root_real,
    preserved_baseline,
  }
  return sealAdmissionRecord(body)
}

export function assertPathListRefreshDeclarationCompatible(
  existing: LiveSessionFilesystemPathListAdmissionV1,
  declarationInput: unknown,
): void {
  const incoming = parseTrustedHostFilesystemPathListDeclaration(declarationInput)
  const existingDeclarationHash = declarationContentHash(existing.declaration)
  const incomingDeclarationHash = declarationContentHash(incoming)
  if (incomingDeclarationHash !== existingDeclarationHash) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_DECLARATION_CONFLICT',
      'Conflicting trusted host filesystem path-list declaration on refresh',
    )
  }
}

export function loadFilesystemPathListAdmissionStrict(
  runDir: string,
  contract: TaskContractV1,
): LiveSessionFilesystemPathListAdmissionV1 | undefined {
  if (!taskContractBindsPathListAdmission(contract)) return undefined
  const path = join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)
  if (!existsSync(path)) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_MISSING',
      `Filesystem path-list admission is bound but missing in ${runDir}`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new LiveSessionAuthorityError(
      'PATH_LIST_ADMISSION_INVALID',
      `Filesystem path-list admission is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const admission = parseAdmissionRecord(raw)
  assertTaskMatchesAdmission(contract, admission)
  assertAdmissionMatchesContractProvenance(admission, contract)
  return admission
}

export function admissionRecordForPersistence(
  admission: LiveSessionFilesystemPathListAdmissionV1,
): LiveSessionFilesystemPathListAdmissionV1 {
  return admission
}
