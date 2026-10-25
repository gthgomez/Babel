/**
 * Pure read-only filesystem path-list verifier (stage 1).
 * Result is diagnostic only — not trusted completion evidence until stage 2 wiring.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isCredentialTargetPath } from './protectedPath.js'
import {
  declarationContentHash,
  type TrustedHostFilesystemPathListDeclarationV1,
} from './trustedHostFilesystemPathList.js'

export const FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND =
  'filesystem_path_list_verifier_result_v1' as const

export type ResolveStatus =
  | 'ok'
  | 'missing'
  | 'escape'
  | 'credential_denied'
  | 'duplicate'
  | 'malformed'

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
  readonly captured_at: string
  /** Content sha256 for preserved files at capture; directories marked present only. */
  readonly preserved: Readonly<Record<string, { kind: 'file' | 'directory'; content_sha256?: string }>>
  /** Repo-relative file paths under inventory scope at capture (sorted). */
  readonly inventory_snapshot: readonly string[]
}

export interface FilesystemPathListVerifierResultV1 {
  readonly schema_version: 1
  readonly kind: typeof FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND
  readonly status: 'passed' | 'failed' | 'unsupported'
  readonly reason_code: string
  readonly declaration_hash: string
  readonly target_document: string
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
    if (!match?.[1]) continue
    const normalized = normalizeRepoRelativePath(match[1])
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

function listScopedInventoryFiles(rootReal: string, scopeRoots: readonly string[]): string[] {
  const inventory = new Set<string>()
  for (const scopeRoot of scopeRoots) {
    const absScope = resolve(rootReal, scopeRoot)
    const scopeReal = realpathSync.native(absScope)
    if (!isContainedInRoot(rootReal, scopeReal)) continue
    const walk = (dirReal: string, relPrefix: string) => {
      for (const name of readdirSync(dirReal)) {
        if (name === '.git') continue
        const abs = join(dirReal, name)
        let entryReal: string
        try {
          entryReal = realpathSync.native(abs)
        } catch {
          continue
        }
        if (!isContainedInRoot(rootReal, entryReal)) continue
        const rel = posixRelative(rootReal, entryReal)
        if (!rel || isCredentialTargetPath(rel)) continue
        const st = lstatSync(entryReal)
        if (st.isDirectory()) {
          walk(entryReal, rel)
        } else if (st.isFile()) {
          inventory.add(rel)
        }
      }
    }
    if (existsSync(scopeReal) && statSync(scopeReal).isDirectory()) walk(scopeReal, scopeRoot)
  }
  return [...inventory].sort()
}

function resolveDeclaredPath(
  rootReal: string,
  declared: string,
): { status: ResolveStatus; exists: boolean } {
  if (isCredentialTargetPath(declared)) return { status: 'credential_denied', exists: false }
  const abs = resolve(rootReal, declared)
  let real: string
  try {
    if (!existsSync(abs)) return { status: 'missing', exists: false }
    real = realpathSync.native(abs)
  } catch {
    return { status: 'missing', exists: false }
  }
  if (!isContainedInRoot(rootReal, real)) return { status: 'escape', exists: false }
  const rel = posixRelative(rootReal, real)
  if (!rel || isCredentialTargetPath(rel)) return { status: 'credential_denied', exists: false }
  return { status: 'ok', exists: true }
}

/** Capture baselines from the actual filesystem (not declaration-embedded answers). */
export function captureFilesystemSourceBaseline(
  projectRoot: string,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): FilesystemSourceBaselineV1 {
  const rootReal = projectRootReal(projectRoot)
  const preserved: Record<string, { kind: 'file' | 'directory'; content_sha256?: string }> = {}
  for (const selector of declaration.preserved_input_selectors) {
    const abs = resolve(rootReal, selector)
    if (!existsSync(abs)) continue
    const real = realpathSync.native(abs)
    if (!isContainedInRoot(rootReal, real)) continue
    const rel = posixRelative(rootReal, real)
    if (!rel || isCredentialTargetPath(rel)) continue
    const st = statSync(real)
    if (st.isDirectory()) {
      preserved[rel] = { kind: 'directory' }
    } else if (st.isFile()) {
      preserved[rel] = { kind: 'file', content_sha256: hashFileContent(real) }
    }
  }
  const inventory_snapshot = listScopedInventoryFiles(rootReal, declaration.inventory_scope.roots)
  return Object.freeze({
    schema_version: 1,
    kind: 'filesystem_source_baseline_v1',
    declaration_hash: declarationContentHash(declaration),
    captured_at: new Date().toISOString(),
    preserved: Object.freeze(preserved),
    inventory_snapshot: Object.freeze(inventory_snapshot),
  })
}

function check(
  pass: boolean,
  reason: string,
): CheckOutcomeV1 {
  return pass ? { status: 'pass' } : { status: 'fail', reason_code: reason }
}

function failedResult(
  partial: Omit<FilesystemPathListVerifierResultV1, 'status' | 'reason_code'> & { reason_code: string },
): FilesystemPathListVerifierResultV1 {
  return Object.freeze({ ...partial, status: 'failed' })
}

/** Pure verifier — result is not completion authority (stage 1). */
export function verifyFilesystemPathList(
  projectRoot: string,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
  baseline: FilesystemSourceBaselineV1,
): FilesystemPathListVerifierResultV1 {
  const declaration_hash = declarationContentHash(declaration)
  if (baseline.declaration_hash !== declaration_hash) {
    return Object.freeze({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      status: 'unsupported',
      reason_code: 'baseline_declaration_mismatch',
      declaration_hash,
      target_document: declaration.target_document,
      checks: {
        document_parseable: { status: 'skip', reason_code: 'baseline_declaration_mismatch' },
        all_entries_resolve: { status: 'skip', reason_code: 'baseline_declaration_mismatch' },
        no_duplicate_entries: { status: 'skip', reason_code: 'baseline_declaration_mismatch' },
        coverage_complete: { status: 'skip', reason_code: 'baseline_declaration_mismatch' },
        preserved_inputs_unchanged: { status: 'skip', reason_code: 'baseline_declaration_mismatch' },
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
    })
  }

  const rootReal = projectRootReal(projectRoot)
  const targetAbs = resolve(rootReal, declaration.target_document)
  if (!existsSync(targetAbs)) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: 'target_document_missing',
      declaration_hash,
      target_document: declaration.target_document,
      checks: {
        document_parseable: check(false, 'target_document_missing'),
        all_entries_resolve: check(false, 'target_document_missing'),
        no_duplicate_entries: check(false, 'target_document_missing'),
        coverage_complete: check(false, 'target_document_missing'),
        preserved_inputs_unchanged: check(false, 'target_document_missing'),
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
    })
  }

  let documentText: string
  try {
    documentText = readFileSync(targetAbs, 'utf8')
  } catch {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: 'target_document_unreadable',
      declaration_hash,
      target_document: declaration.target_document,
      checks: {
        document_parseable: check(false, 'target_document_unreadable'),
        all_entries_resolve: check(false, 'target_document_unreadable'),
        no_duplicate_entries: check(false, 'target_document_unreadable'),
        coverage_complete: check(false, 'target_document_unreadable'),
        preserved_inputs_unchanged: check(false, 'target_document_unreadable'),
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
    })
  }

  const parsed = parseMarkdownBulletPaths(documentText, declaration.limits)
  if (!parsed.ok) {
    return failedResult({
      schema_version: 1,
      kind: FILESYSTEM_PATH_LIST_VERIFIER_RESULT_KIND,
      reason_code: parsed.reason,
      declaration_hash,
      target_document: declaration.target_document,
      checks: {
        document_parseable: check(false, parsed.reason),
        all_entries_resolve: check(false, parsed.reason),
        no_duplicate_entries: check(false, parsed.reason),
        coverage_complete: check(false, parsed.reason),
        preserved_inputs_unchanged: check(true, 'not_evaluated'),
      },
      entries: [],
      inventory_extra_paths: [],
      inventory_missing_paths: [],
      preserved_drift_paths: [],
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
  const currentInventory = listScopedInventoryFiles(rootReal, declaration.inventory_scope.roots)
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
    const real = realpathSync.native(abs)
    if (!isContainedInRoot(rootReal, real)) {
      preserved_drift_paths.push(rel)
      continue
    }
    if (snapshot.kind === 'directory') {
      if (!statSync(real).isDirectory()) preserved_drift_paths.push(rel)
      continue
    }
    if (!statSync(real).isFile()) {
      preserved_drift_paths.push(rel)
      continue
    }
    if (hashFileContent(real) !== snapshot.content_sha256) preserved_drift_paths.push(rel)
  }

  const coverageOk =
    inventory_missing_paths.length === 0 &&
    inventory_extra_paths.length === 0 &&
    allResolve &&
    !hasDuplicate
  const preservedOk = preserved_drift_paths.length === 0

  const checks = {
    document_parseable: check(true, 'ok'),
    all_entries_resolve: check(allResolve, 'entry_resolve_failed'),
    no_duplicate_entries: check(!hasDuplicate, 'duplicate_entry'),
    coverage_complete: check(coverageOk, 'inventory_mismatch'),
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
    checks,
    entries: Object.freeze(entries),
    inventory_extra_paths: Object.freeze(inventory_extra_paths),
    inventory_missing_paths: Object.freeze(inventory_missing_paths),
    preserved_drift_paths: Object.freeze([...preserved_drift_paths].sort()),
  })
}
