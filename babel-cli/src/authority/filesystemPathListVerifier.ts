/**
 * Pure read-only filesystem path-list verifier (stage 1).
 * Result is diagnostic only — not trusted completion evidence until stage 2 wiring.
 *
 * Inventory coverage compares the parsed target document to the **current** scoped
 * inventory on disk. `baseline.inventory_snapshot` is capture metadata only and is
 * not consulted during verification (no unchanged-since-baseline inventory evidence).
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isCredentialTargetPath } from './protectedPath.js'
import {
  declarationContentHash,
  type TrustedHostFilesystemPathListDeclarationV1,
} from './trustedHostFilesystemPathList.js'

export const FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND =
  'filesystem_path_list_verifier_result_v1' as const

export const INVENTORY_VERIFICATION_EVIDENCE_MODE =
  'current_document_vs_current_inventory' as const

export type InventoryVerificationEvidenceMode = typeof INVENTORY_VERIFICATION_EVIDENCE_MODE

export type ResolveStatus =
  | 'ok'
  | 'missing'
  | 'escape'
  | 'credential_denied'
  | 'duplicate'
  | 'malformed'
  | 'symlink'

export interface CheckOutcomeV1 {
  status: 'pass' | 'fail' | 'skip'
  reason_code?: string
}

export interface DeclaredEntryV1 {
  declared_path: string
  resolve_status: ResolveStatus
}

export interface FilesystemSourceBaselineV1 {
  readonly schema_version: 1
  readonly kind: 'filesystem_source_baseline_v1'
  readonly declaration_hash: string
  /** Canonical project root at capture; must match verifier `projectRoot`. */
  readonly project_root_real: string
  readonly captured_at: string
  /** Content sha256 for preserved regular files at capture (literal paths only). */
  readonly preserved: Readonly<Record<string, { kind: 'file'; content_sha256: string }>>
  /**
   * Repo-relative file paths under inventory scope at capture (sorted).
   * Not used by `verifyFilesystemPathList` — diagnostic / stage-2 provenance only.
   */
  readonly inventory_snapshot: readonly string[]
}

export interface FilesystemPathListVerifierResultV1 {
  readonly schema_version: 1
  readonly kind: typeof FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND
  readonly status: 'passed' | 'failed' | 'unsupported'
  readonly reason_code: string
  readonly declaration_hash: string
  readonly target_document: string
  readonly inventory_evidence_mode: InventoryVerificationEvidenceMode
  readonly checks: {
    document_parseable: CheckOutcomeV1
    all_entries_resolve: CheckOutcomeV1
    no_duplicate_entries: CheckOutcomeV1
    coverage_complete: CheckOutcomeV1
    preserved_inputs_unchanged: CheckOutcomeV1
  }
  readonly entries: readonly DeclaredEntryV1[]
  readonly inventory_extra_paths: readonly string[]
  readonly inventory_missing_paths: readonly string[]
  readonly preserved_drift_paths: readonly string[]
  readonly inventory_scope_errors: readonly string[]
}

function posixRelative(root: string, absolute: string): string | null {
  const rel = relative(root, absolute).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..') || rel.includes('/..')) return null
  return rel
}

function projectRootReal(projectRoot: string): string {
  return realpathSync.native(projectRoot)
}

function isContainedInRoot(rootReal: string, candidateReal: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  return candidateReal === rootReal || candidateReal.startsWith(prefix)
}

function hasGlobOrEscapeSyntax(raw: string): boolean {
  return /[*?[\]{}]/.test(raw) || raw.includes('**')
}

/** Normalize a repo-relative path from document bullets or runtime checks. */
export function normalizeRepoRelativePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const norm = trimmed.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null
  if (norm.includes('..') || norm.includes('\0')) return null
  const parts = norm.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) return null
  const joined = parts.join('/')
  if (joined.length > 512) return null
  if (isCredentialTargetPath(joined)) return null
  return joined
}

/** Stricter normalization for declaration-bound path fields (rejects rooted backslash absolutes). */
export function normalizeDeclarationRepoRelativePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(trimmed)) return null
  if (hasGlobOrEscapeSyntax(trimmed.replace(/\\/g, '/'))) return null
  return normalizeRepoRelativePath(trimmed)
}

/** Parse markdown bullet paths from document bytes. */
export function parseMarkdownBulletPaths(
  text: string,
  limits: TrustedHostFilesystemPathListDeclarationV1['limits'],
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes === 0) return { ok: false, reason: 'empty_document' }
  if (bytes > limits.max_document_bytes) return { ok: false, reason: 'document_too_large' }
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)
    if (!match) {
      if (/^(?:[-*+]|\d+[.)])\s*$/.test(trimmed)) return { ok: false, reason: 'malformed_entry' }
      continue
    }
    const payload = match[1]?.trim()
    if (!payload) return { ok: false, reason: 'malformed_entry' }
    const normalized = normalizeRepoRelativePath(payload)
    if (!normalized) return { ok: false, reason: 'malformed_entry' }
    paths.push(normalized)
    if (paths.length > limits.max_entries) return { ok: false, reason: 'too_many_entries' }
  }
  if (paths.length === 0) return { ok: false, reason: 'no_entries' }
  return { ok: true, paths }
}

function hashFileContent(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

function readBoundedUtf8FileSync(absolutePath: string, maxBytes: number): { ok: true; text: string } | { ok: false; reason: string } {
  let fd: number | undefined
  try {
    fd = openSync(absolutePath, 'r')
    const st = fstatSync(fd)
    if (!st.isFile()) return { ok: false, reason: 'target_not_regular_file' }
    if (st.size > maxBytes) return { ok: false, reason: 'document_too_large' }
    const buf = Buffer.alloc(st.size)
    const read = readSync(fd, buf, 0, st.size, 0)
    if (read !== st.size) return { ok: false, reason: 'target_document_unreadable' }
    return { ok: true, text: buf.toString('utf8') }
  } catch {
    return { ok: false, reason: 'target_document_unreadable' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

type InventoryListResult =
  | { ok: true; files: string[] }
  | { ok: false; errors: string[] }

function validateScopeRoot(rootReal: string, scopeRoot: string): { ok: true; dirReal: string } | { ok: false; error: string } {
  const normalized = normalizeDeclarationRepoRelativePath(scopeRoot)
  if (!normalized) return { ok: false, error: `invalid_scope_root:${scopeRoot}` }
  const abs = resolve(rootReal, normalized)
  if (!existsSync(abs)) return { ok: false, error: `missing_scope_root:${normalized}` }
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(abs)
  } catch {
    return { ok: false, error: `missing_scope_root:${normalized}` }
  }
  if (lst.isSymbolicLink()) return { ok: false, error: `symlink_scope_root:${normalized}` }
  if (!lst.isDirectory()) return { ok: false, error: `not_directory_scope_root:${normalized}` }
  let dirReal: string
  try {
    dirReal = realpathSync.native(abs)
  } catch {
    return { ok: false, error: `missing_scope_root:${normalized}` }
  }
  if (!isContainedInRoot(rootReal, dirReal)) return { ok: false, error: `escape_scope_root:${normalized}` }
  return { ok: true, dirReal }
}

function listScopedInventoryFiles(rootReal: string, scopeRoots: readonly string[]): InventoryListResult {
  const inventory = new Set<string>()
  const errors: string[] = []

  for (const scopeRoot of scopeRoots) {
    const validated = validateScopeRoot(rootReal, scopeRoot)
    if (!validated.ok) {
      errors.push(validated.error)
      continue
    }
    const walk = (dirReal: string): boolean => {
      for (const name of readdirSync(dirReal)) {
        if (name === '.git') continue
        const abs = join(dirReal, name)
        let lst: ReturnType<typeof lstatSync>
        try {
          lst = lstatSync(abs)
        } catch {
          errors.push(`unreadable_inventory_entry:${join(scopeRoot, name)}`)
          return false
        }
        if (lst.isSymbolicLink()) {
          errors.push(`symlink_in_inventory_scope:${posixRelative(rootReal, abs) ?? name}`)
          return false
        }
        let entryReal: string
        try {
          entryReal = realpathSync.native(abs)
        } catch {
          errors.push(`unreadable_inventory_entry:${name}`)
          return false
        }
        if (!isContainedInRoot(rootReal, entryReal)) {
          errors.push(`escape_inventory_entry:${name}`)
          return false
        }
        const rel = posixRelative(rootReal, entryReal)
        if (!rel || isCredentialTargetPath(rel)) continue
        if (lst.isDirectory()) {
          if (!walk(entryReal)) return false
        } else if (lst.isFile()) {
          inventory.add(rel)
        }
      }
      return true
    }
    if (!walk(validated.dirReal)) {
      // errors already recorded
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, files: [...inventory].sort() }
}

function resolveDeclaredPath(
  rootReal: string,
  declared: string,
): { status: ResolveStatus; exists: boolean } {
  if (isCredentialTargetPath(declared)) return { status: 'credential_denied', exists: false }
  const abs = resolve(rootReal, declared)
  if (!existsSync(abs)) return { status: 'missing', exists: false }
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(abs)
  } catch {
    return { status: 'missing', exists: false }
  }
  if (lst.isSymbolicLink()) return { status: 'symlink', exists: false }
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch {
    return { status: 'missing', exists: false }
  }
  if (!isContainedInRoot(rootReal, real)) return { status: 'escape', exists: false }
  const rel = posixRelative(rootReal, real)
  if (!rel || isCredentialTargetPath(rel)) return { status: 'credential_denied', exists: false }
  if (!lst.isFile()) return { status: 'missing', exists: false }
  return { status: 'ok', exists: true }
}

function validateTargetDocumentForRead(
  rootReal: string,
  targetDocument: string,
): { ok: true; fileReal: string } | { ok: false; reason_code: string } {
  const normalized = normalizeDeclarationRepoRelativePath(targetDocument)
  if (!normalized || normalized !== targetDocument) {
    return { ok: false, reason_code: 'target_document_invalid' }
  }
  const abs = resolve(rootReal, normalized)
  if (!existsSync(abs)) return { ok: false, reason_code: 'target_document_missing' }
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(abs)
  } catch {
    return { ok: false, reason_code: 'target_document_missing' }
  }
  if (lst.isSymbolicLink()) return { ok: false, reason_code: 'target_document_symlink' }
  if (!lst.isFile()) return { ok: false, reason_code: 'target_not_regular_file' }
  let fileReal: string
  try {
    fileReal = realpathSync.native(abs)
  } catch {
    return { ok: false, reason_code: 'target_document_missing' }
  }
  if (!isContainedInRoot(rootReal, fileReal)) return { ok: false, reason_code: 'target_document_escape' }
  if (isCredentialTargetPath(normalized)) return { ok: false, reason_code: 'target_document_credential_denied' }
  return { ok: true, fileReal }
}

function capturePreservedFile(
  rootReal: string,
  selector: string,
): { ok: true; rel: string; content_sha256: string } | { ok: false; error: string } {
  const normalized = normalizeDeclarationRepoRelativePath(selector)
  if (!normalized) return { ok: false, error: `invalid_preserved_selector:${selector}` }
  const abs = resolve(rootReal, normalized)
  if (!existsSync(abs)) return { ok: false, error: `missing_preserved:${normalized}` }
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(abs)
  } catch {
    return { ok: false, error: `missing_preserved:${normalized}` }
  }
  if (lst.isSymbolicLink()) return { ok: false, error: `symlink_preserved:${normalized}` }
  if (!lst.isFile()) return { ok: false, error: `not_file_preserved:${normalized}` }
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch {
    return { ok: false, error: `missing_preserved:${normalized}` }
  }
  if (!isContainedInRoot(rootReal, real)) return { ok: false, error: `escape_preserved:${normalized}` }
  const rel = posixRelative(rootReal, real)
  if (!rel || rel !== normalized || isCredentialTargetPath(rel)) {
    return { ok: false, error: `escape_preserved:${normalized}` }
  }
  return { ok: true, rel, content_sha256: hashFileContent(real) }
}

/** Capture baselines from the actual filesystem (not declaration-embedded answers). */
export function captureFilesystemSourceBaseline(
  projectRoot: string,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): FilesystemSourceBaselineV1 {
  const rootReal = projectRootReal(projectRoot)
  const preserved: Record<string, { kind: 'file'; content_sha256: string }> = {}
  for (const selector of declaration.preserved_input_selectors) {
    const captured = capturePreservedFile(rootReal, selector)
    if (!captured.ok) {
      throw new Error(`FILESYSTEM_SOURCE_BASELINE_CAPTURE_FAILED: ${captured.error}`)
    }
    preserved[captured.rel] = { kind: 'file', content_sha256: captured.content_sha256 }
  }
  const inventory = listScopedInventoryFiles(rootReal, declaration.inventory_scope.roots)
  if (!inventory.ok) {
    throw new Error(`FILESYSTEM_SOURCE_BASELINE_CAPTURE_FAILED: ${inventory.errors.join(';')}`)
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'filesystem_source_baseline_v1',
    declaration_hash: declarationContentHash(declaration),
    project_root_real: rootReal,
    captured_at: new Date().toISOString(),
    preserved: Object.freeze(preserved),
    inventory_snapshot: Object.freeze(inventory.files),
  })
}

function check(pass: boolean, reason: string): CheckOutcomeV1 {
  return pass ? { status: 'pass' } : { status: 'fail', reason_code: reason }
}

function skip(reason: string): CheckOutcomeV1 {
  return { status: 'skip', reason_code: reason }
}

function failedResult(
  partial: Omit<FilesystemPathListVerifierResultV1, 'status' | 'reason_code'> & { reason_code: string },
): FilesystemPathListVerifierResultV1 {
  return Object.freeze({ ...partial, status: 'failed' })
}

function emptyChecksSkipped(reason: string): FilesystemPathListVerifierResultV1['checks'] {
  return {
    document_parseable: skip(reason),
    all_entries_resolve: skip(reason),
    no_duplicate_entries: skip(reason),
    coverage_complete: skip(reason),
    preserved_inputs_unchanged: skip(reason),
  }
}

function failAllChecks(reason: string): FilesystemPathListVerifierResultV1['checks'] {
  return {
    document_parseable: check(false, reason),
    all_entries_resolve: check(false, reason),
    no_duplicate_entries: check(false, reason),
    coverage_complete: check(false, reason),
    preserved_inputs_unchanged: check(false, reason),
  }
}

/** Pure verifier — result is not completion authority (stage 1). */
export function verifyFilesystemPathList(
  projectRoot: string,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
  baseline: FilesystemSourceBaselineV1,
): FilesystemPathListVerifierResultV1 {
  const declaration_hash = declarationContentHash(declaration)
  const inventory_evidence_mode = INVENTORY_VERIFICATION_EVIDENCE_MODE

  if (baseline.declaration_hash !== declaration_hash) {
    return Object.freeze({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      status: 'unsupported',
      reason_code: 'baseline_declaration_mismatch',
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: emptyChecksSkipped('baseline_declaration_mismatch'),
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: [],
    })
  }

  const rootReal = projectRootReal(projectRoot)
  if (baseline.project_root_real !== rootReal) {
    return Object.freeze({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      status: 'unsupported',
      reason_code: 'baseline_project_root_mismatch',
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: emptyChecksSkipped('baseline_project_root_mismatch'),
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: [],
    })
  }

  const targetValidated = validateTargetDocumentForRead(rootReal, declaration.target_document)
  if (!targetValidated.ok) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: targetValidated.reason_code,
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: failAllChecks(targetValidated.reason_code),
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: [],
    })
  }

  const documentRead = readBoundedUtf8FileSync(targetValidated.fileReal, declaration.limits.max_document_bytes)
  if (!documentRead.ok) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: documentRead.reason,
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: failAllChecks(documentRead.reason),
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: [],
    })
  }

  const parsed = parseMarkdownBulletPaths(documentRead.text, declaration.limits)
  if (!parsed.ok) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: parsed.reason,
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: {
        document_parseable: check(false, parsed.reason),
        all_entries_resolve: check(false, parsed.reason),
        no_duplicate_entries: check(false, parsed.reason),
        coverage_complete: check(false, parsed.reason),
        preserved_inputs_unchanged: skip('not_evaluated'),
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: [],
    })
  }

  const inventoryListed = listScopedInventoryFiles(rootReal, declaration.inventory_scope.roots)
  if (!inventoryListed.ok) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: 'inventory_scope_invalid',
      declaration_hash,
      target_document: declaration.target_document,
      inventory_evidence_mode,
      checks: {
        document_parseable: check(true, 'ok'),
        all_entries_resolve: check(false, 'inventory_scope_invalid'),
        no_duplicate_entries: check(false, 'inventory_scope_invalid'),
        coverage_complete: check(false, 'inventory_scope_invalid'),
        preserved_inputs_unchanged: check(false, 'inventory_scope_invalid'),
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
      inventory_scope_errors: Object.freeze([...inventoryListed.errors]),
    })
  }

  const entries: DeclaredEntryV1[] = []
  const seen = new Set<string>()
  let hasDuplicate = false
  let allResolve = true
  for (const declared_path of parsed.paths) {
    let resolve_status: ResolveStatus
    if (seen.has(declared_path)) {
      hasDuplicate = true
      resolve_status = 'duplicate'
      allResolve = false
    } else {
      seen.add(declared_path)
      const resolved = resolveDeclaredPath(rootReal, declared_path)
      resolve_status = resolved.status
      if (resolve_status !== 'ok') allResolve = false
    }
    entries.push({ declared_path, resolve_status })
  }

  const declaredSet = new Set(parsed.paths)
  const currentInventory = inventoryListed.files
  const currentSet = new Set(currentInventory)
  const inventory_missing_paths = currentInventory.filter(path => !declaredSet.has(path))
  const inventory_extra_paths = [...declaredSet].filter(path => !currentSet.has(path)).sort()

  const preserved_drift_paths: string[] = []
  for (const [rel, snapshot] of Object.entries(baseline.preserved)) {
    const abs = resolve(rootReal, rel)
    if (!existsSync(abs)) {
      preserved_drift_paths.push(rel)
      continue
    }
    let lst: ReturnType<typeof lstatSync>
    try {
      lst = lstatSync(abs)
    } catch {
      preserved_drift_paths.push(rel)
      continue
    }
    if (lst.isSymbolicLink() || !lst.isFile()) {
      preserved_drift_paths.push(rel)
      continue
    }
    let real: string
    try {
      real = realpathSync.native(abs)
    } catch {
      preserved_drift_paths.push(rel)
      continue
    }
    if (!isContainedInRoot(rootReal, real)) {
      preserved_drift_paths.push(rel)
      continue
    }
    if (hashFileContent(real) !== snapshot.content_sha256) preserved_drift_paths.push(rel)
  }

  const scopeOk = inventoryListed.ok
  const coverageOk =
    scopeOk &&
    inventory_missing_paths.length === 0 &&
    inventory_extra_paths.length === 0 &&
    allResolve &&
    !hasDuplicate
  const preservedOk = preserved_drift_paths.length === 0

  const checks = {
    document_parseable: check(true, 'ok'),
    all_entries_resolve: check(allResolve, 'entry_resolve_failed'),
    no_duplicate_entries: check(!hasDuplicate, 'duplicate_entry'),
    coverage_complete: check(coverageOk, scopeOk ? 'inventory_mismatch' : 'inventory_scope_invalid'),
    preserved_inputs_unchanged: check(preservedOk, 'preserved_input_drift'),
  }

  const passed =
    checks.document_parseable.status === 'pass' &&
    checks.all_entries_resolve.status === 'pass' &&
    checks.no_duplicate_entries.status === 'pass' &&
    checks.coverage_complete.status === 'pass' &&
    checks.preserved_inputs_unchanged.status === 'pass'

  return Object.freeze({
    schema_version: 1,
    kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
    status: passed ? 'passed' : 'failed',
    reason_code: passed ? 'all_checks_passed' : 'verification_failed',
    declaration_hash,
    target_document: declaration.target_document,
    inventory_evidence_mode,
    checks,
    entries: Object.freeze(entries),
    inventory_extra_paths: Object.freeze(inventory_extra_paths),
    inventory_missing_paths: Object.freeze(inventory_missing_paths),
    preserved_drift_paths: Object.freeze([...preserved_drift_paths].sort()),
    inventory_scope_errors: Object.freeze([]),
  })
}
