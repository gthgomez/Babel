/**
 * Trusted-host filesystem path-list declaration (stage 1).
 * Not a natural-language acceptance fix; not model-writable authority.
 */
import { sha256Canonical } from '../acceptance/canonical.js'
import { isCredentialTargetPath } from './protectedPath.js'

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

export const TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND =
  'trusted_host_filesystem_path_list_declaration_v1' as const

export const MARKDOWN_BULLET_PATHS_FORMAT = 'markdown_bullet_paths' as const

export type MarkdownBulletPathsFormat = typeof MARKDOWN_BULLET_PATHS_FORMAT

export interface InventoryScopeV1 {
  /** Repo-relative roots; inventory is the union of regular files under these roots. */
  readonly roots: readonly string[]
}

export interface InventoryCoverageV1 {
  /** Document must list exactly the current scoped inventory (complete listing). */
  readonly mode: 'complete_scoped_inventory'
}

export interface DeclarationLimitsV1 {
  readonly max_document_bytes: number
  readonly max_entries: number
}

export const TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND =
  'trusted_host_acceptance_clarification_v1' as const

export const HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE =
  'host_declared_acceptance_clarification' as const

/** Host-declared clarification of one acceptance row — not natural-language inference. */
export interface TrustedHostAcceptanceClarificationBindingV1 {
  readonly schema_version: 1
  readonly kind: typeof TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND
  readonly clarification_mode: typeof HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE
  readonly target_criterion_id: string
  readonly task_request_digest: string
  readonly meaning_input_digest: string
  readonly meaning_provenance_ref?: string
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
  /** Literal repo-relative regular-file paths only (no globs, no directories). */
  readonly preserved_input_selectors: readonly string[]
  readonly limits: DeclarationLimitsV1
  readonly acceptance_clarification?: TrustedHostAcceptanceClarificationBindingV1
}

const MAX_ROOTS = 64
const MAX_PRESERVED = 128
const MAX_REQUEST_CHARS = 65_536
const DEFAULT_LIMITS: DeclarationLimitsV1 = {
  max_document_bytes: 256_000,
  max_entries: 4_096,
}

function invalid(message: string): never {
  throw new Error(`TRUSTED_HOST_FILESYSTEM_DECLARATION_INVALID: ${message}`)
}

function hasGlobSyntax(path: string): boolean {
  return /[*?[\]{}]/.test(path) || path.includes('**')
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

function parseRepoRelativePathField(raw: unknown, field: string): string {
  if (typeof raw !== 'string') invalid(field)
  const normalized = normalizeDeclarationRepoRelativePath(raw)
  if (!normalized) invalid(field)
  return normalized
}

/** Parse optional host-declared acceptance clarification binding. */
export function parseTrustedHostAcceptanceClarificationBinding(
  value: unknown,
  declarationUserRequestDigest: string,
): TrustedHostAcceptanceClarificationBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('acceptance_clarification')
  const input = value as Record<string, unknown>
  if (input['schema_version'] !== 1) invalid('acceptance_clarification.schema_version')
  if (input['kind'] !== TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND) invalid('acceptance_clarification.kind')
  if (input['clarification_mode'] !== HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE) {
    invalid('acceptance_clarification.clarification_mode')
  }
  if (typeof input['target_criterion_id'] !== 'string' || !input['target_criterion_id'].trim()) {
    invalid('acceptance_clarification.target_criterion_id')
  }
  if (
    typeof input['task_request_digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(input['task_request_digest'])
  ) {
    invalid('acceptance_clarification.task_request_digest')
  }
  if (input['task_request_digest'].toLowerCase() !== declarationUserRequestDigest) {
    invalid('acceptance_clarification.task_request_digest mismatch')
  }
  if (
    typeof input['meaning_input_digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(input['meaning_input_digest'])
  ) {
    invalid('acceptance_clarification.meaning_input_digest')
  }
  const meaning_provenance_ref =
    input['meaning_provenance_ref'] === undefined
      ? undefined
      : typeof input['meaning_provenance_ref'] === 'string' &&
          input['meaning_provenance_ref'].trim()
        ? input['meaning_provenance_ref'].trim()
        : invalid('acceptance_clarification.meaning_provenance_ref')
  return Object.freeze({
    schema_version: 1,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: input['target_criterion_id'].trim(),
    task_request_digest: input['task_request_digest'].toLowerCase(),
    meaning_input_digest: input['meaning_input_digest'].toLowerCase(),
    ...(meaning_provenance_ref ? { meaning_provenance_ref } : {}),
  })
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

  const target_document = parseRepoRelativePathField(input['target_document'], 'target_document')
  if (input['format_profile'] !== MARKDOWN_BULLET_PATHS_FORMAT) invalid('format_profile')

  const scopeRaw = input['inventory_scope']
  if (!scopeRaw || typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) invalid('inventory_scope')
  const rootsRaw = (scopeRaw as Record<string, unknown>)['roots']
  if (!Array.isArray(rootsRaw) || rootsRaw.length === 0 || rootsRaw.length > MAX_ROOTS) invalid('inventory_scope.roots')
  const roots = rootsRaw.map(root => parseRepoRelativePathField(root, 'inventory_scope.roots entry'))

  const coverageRaw = input['coverage']
  if (!coverageRaw || typeof coverageRaw !== 'object' || Array.isArray(coverageRaw)) invalid('coverage')
  if ((coverageRaw as Record<string, unknown>)['mode'] !== 'complete_scoped_inventory') invalid('coverage.mode')

  const preservedRaw = input['preserved_input_selectors']
  if (!Array.isArray(preservedRaw) || preservedRaw.length > MAX_PRESERVED) invalid('preserved_input_selectors')
  const preserved_input_selectors = preservedRaw.map(entry => {
    const path = parseRepoRelativePathField(entry, 'preserved_input_selectors entry')
    if (hasGlobSyntax(path)) invalid('preserved_input_selectors glob not supported')
    return path
  })

  const acceptance_clarification =
    input['acceptance_clarification'] === undefined
      ? undefined
      : parseTrustedHostAcceptanceClarificationBinding(input['acceptance_clarification'], digest)

  return Object.freeze({
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: input['declaration_id'].trim(),
    user_request: input['user_request'],
    user_request_digest: digest,
    target_document,
    format_profile: MARKDOWN_BULLET_PATHS_FORMAT,
    inventory_scope: Object.freeze({ roots: Object.freeze([...new Set(roots)]) }),
    coverage: Object.freeze({ mode: 'complete_scoped_inventory' as const }),
    preserved_input_selectors: Object.freeze([...new Set(preserved_input_selectors)]),
    limits: parseLimits(input['limits']),
    ...(acceptance_clarification ? { acceptance_clarification } : {}),
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
    ...(declaration.acceptance_clarification
      ? { acceptance_clarification: declaration.acceptance_clarification }
      : {}),
  })
}
