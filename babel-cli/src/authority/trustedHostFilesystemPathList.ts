/**
 * Trusted-host filesystem path-list declaration (stage 1).
 * Not a natural-language acceptance fix; not model-writable authority.
 */
import { sha256Canonical } from '../acceptance/canonical.js'
import { isCredentialTargetPath } from './protectedPath.js'

export const TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND =
  'trusted_host_filesystem_path_list_declaration_v1' as const

export const MARKDOWN_BULLET_PATHS_FORMAT = 'markdown_bullet_paths' as const

export type MarkdownBulletPathsFormat = typeof MARKDOWN_BULLET_PATHS_FORMAT

export interface InventoryScopeV1 {
  /** Repo-relative roots; inventory is the union of files under these roots. */
  roots: string[]
}

export interface InventoryCoverageV1 {
  /** Document must list exactly the current scoped inventory (complete listing). */
  mode: 'complete_scoped_inventory'
}

export interface DeclarationLimitsV1 {
  max_document_bytes: number
  max_entries: number
}

export interface TrustedHostFilesystemPathListDeclarationV1 {
  readonly schema_version: 1
  readonly kind: typeof TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND
  readonly declaration_id: string
  /** Exact user objective text; digest must match. */
  readonly user_request: string
  readonly user_request_digest: string
  readonly target_document: string
  readonly format_profile: MarkdownBulletPathsFormat
  readonly inventory_scope: InventoryScopeV1
  readonly coverage: InventoryCoverageV1
  /** Repo-relative paths/globs preserved against baseline drift (not expected answers). */
  readonly preserved_input_selectors: string[]
  readonly limits: DeclarationLimitsV1
}

const MAX_ROOTS = 64
const MAX_PRESERVED = 128
const MAX_PATH_LEN = 512
const MAX_REQUEST_CHARS = 65_536
const DEFAULT_LIMITS: DeclarationLimitsV1 = {
  max_document_bytes: 256_000,
  max_entries: 4_096,
}

function invalid(message: string): never {
  throw new Error(`TRUSTED_HOST_FILESYSTEM_DECLARATION_INVALID: ${message}`)
}

function validRepoRelativeSegmentPath(value: string): boolean {
  if (!value || value.length > MAX_PATH_LEN) return false
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const norm = value.replace(/\\/g, '/')
  if (norm.includes('..') || norm.includes('\0')) return false
  const parts = norm.split('/').filter(Boolean)
  return parts.every(part =>
    part.length > 0 &&
    part.length <= 128 &&
    !/^(?:\.|\.{2,})$/.test(part) &&
    !isCredentialTargetPath(part) &&
    !isCredentialTargetPath(norm),
  )
}

function parseLimits(raw: unknown): DeclarationLimitsV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_LIMITS
  const input = raw as Record<string, unknown>
  const max_document_bytes =
    typeof input['max_document_bytes'] === 'number' &&
    Number.isInteger(input['max_document_bytes']) &&
    input['max_document_bytes'] > 0 &&
    input['max_document_bytes'] <= 1_048_576
      ? input['max_document_bytes']
      : DEFAULT_LIMITS.max_document_bytes
  const max_entries =
    typeof input['max_entries'] === 'number' &&
    Number.isInteger(input['max_entries']) &&
    input['max_entries'] > 0 &&
    input['max_entries'] <= 16_384
      ? input['max_entries']
      : DEFAULT_LIMITS.max_entries
  return { max_document_bytes, max_entries }
}

/** Parse and validate a trusted-host declaration; binds exact request digest. */
export function parseTrustedHostFilesystemPathListDeclaration(
  value: unknown,
): TrustedHostFilesystemPathListDeclarationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('not an object')
  const input = value as Record<string, unknown>
  if (input['schema_version'] !== 1) invalid('schema_version')
  if (input['kind'] !== TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND) invalid('kind')
  if (typeof input['declaration_id'] !== 'string' || !input['declaration_id'].trim()) invalid('declaration_id')
  if (typeof input['user_request'] !== 'string' || !input['user_request'].trim()) invalid('user_request')
  if (input['user_request'].length > MAX_REQUEST_CHARS) invalid('user_request too long')
  if (typeof input['user_request_digest'] !== 'string' || !/^[0-9a-f]{64}$/i.test(input['user_request_digest'])) {
    invalid('user_request_digest')
  }
  const digest = sha256Canonical(input['user_request'])
  if (digest !== input['user_request_digest'].toLowerCase()) invalid('user_request_digest mismatch')

  if (typeof input['target_document'] !== 'string' || !validRepoRelativeSegmentPath(input['target_document'])) {
    invalid('target_document')
  }
  if (input['format_profile'] !== MARKDOWN_BULLET_PATHS_FORMAT) invalid('format_profile')

  const scopeRaw = input['inventory_scope']
  if (!scopeRaw || typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) invalid('inventory_scope')
  const rootsRaw = (scopeRaw as Record<string, unknown>)['roots']
  if (!Array.isArray(rootsRaw) || rootsRaw.length === 0 || rootsRaw.length > MAX_ROOTS) invalid('inventory_scope.roots')
  const roots = rootsRaw.map(root => {
    if (typeof root !== 'string' || !validRepoRelativeSegmentPath(root)) invalid('inventory_scope.roots entry')
    return root.replace(/\\/g, '/')
  })

  const coverageRaw = input['coverage']
  if (!coverageRaw || typeof coverageRaw !== 'object' || Array.isArray(coverageRaw)) invalid('coverage')
  if ((coverageRaw as Record<string, unknown>)['mode'] !== 'complete_scoped_inventory') invalid('coverage.mode')

  const preservedRaw = input['preserved_input_selectors']
  if (!Array.isArray(preservedRaw) || preservedRaw.length > MAX_PRESERVED) invalid('preserved_input_selectors')
  const preserved_input_selectors = preservedRaw.map(entry => {
    if (typeof entry !== 'string' || !validRepoRelativeSegmentPath(entry)) invalid('preserved_input_selectors entry')
    return entry.replace(/\\/g, '/')
  })

  return Object.freeze({
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: input['declaration_id'].trim(),
    user_request: input['user_request'],
    user_request_digest: digest,
    target_document: input['target_document'].replace(/\\/g, '/'),
    format_profile: MARKDOWN_BULLET_PATHS_FORMAT,
    inventory_scope: Object.freeze({ roots: Object.freeze([...new Set(roots)]) }),
    coverage: Object.freeze({ mode: 'complete_scoped_inventory' }),
    preserved_input_selectors: Object.freeze([...new Set(preserved_input_selectors)]),
    limits: parseLimits(input['limits']),
  })
}

export function declarationContentHash(
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): string {
  return sha256Canonical({
    schema_version: declaration.schema_version,
    kind: declaration.kind,
    declaration_id: declaration.declaration_id,
    user_request_digest: declaration.user_request_digest,
    target_document: declaration.target_document,
    format_profile: declaration.format_profile,
    inventory_scope: declaration.inventory_scope,
    coverage: declaration.coverage,
    preserved_input_selectors: declaration.preserved_input_selectors,
    limits: declaration.limits,
  })
}
