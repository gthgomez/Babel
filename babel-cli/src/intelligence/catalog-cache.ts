import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hashCanonical } from './hash.js'
import type {
  CatalogSnapshot,
  CatalogSourceCompleteness,
  CatalogSourceStatus,
} from './types.js'

/**
 * Non-secret cache identity for one catalog source read.
 *
 * `credentialScope` is an opaque provenance label (for example an account
 * revision), never a token or a reversible fingerprint of a secret. Two custom
 * endpoints serving the same provider/model strings must not share an entry.
 */
export interface CatalogCacheIdentity {
  sourceId: string
  endpoint: string
  scopeId?: string
  credentialScope?: string
}

/** Last-known-good cache record for one {@link CatalogCacheIdentity}. */
export interface CatalogCacheEntry {
  schemaVersion: 1
  identity: Required<Pick<CatalogCacheIdentity, 'sourceId' | 'endpoint'>> &
    Pick<CatalogCacheIdentity, 'scopeId' | 'credentialScope'>
  revision: string
  observedAt: string
  writtenAt: string
  status: CatalogSourceStatus
  completeness: CatalogSourceCompleteness
  snapshot: CatalogSnapshot
}

/** Stable hash for a cache identity; safe to use in a file name. */
export function catalogCacheKey(identity: CatalogCacheIdentity): string {
  assertIdentity(identity)
  return hashCanonical({
    sourceId: identity.sourceId,
    endpoint: identity.endpoint,
    scopeId: identity.scopeId ?? null,
    credentialScope: identity.credentialScope ?? null,
  })
}

/** Resolve the on-disk path for a cache identity without touching the disk. */
export function catalogCachePath(directory: string, identity: CatalogCacheIdentity): string {
  return join(directory, `catalog-${catalogCacheKey(identity)}.json`)
}

/** Read the last-known-good entry for an identity, or undefined when absent. */
export async function readCatalogCache(input: {
  directory: string
  identity: CatalogCacheIdentity
}): Promise<CatalogCacheEntry | undefined> {
  const path = catalogCachePath(input.directory, input.identity)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return decodeCatalogCacheEntry(raw, input.identity)
}

/** Outcome of a cache write; `retainedPrevious` means last-known-good won. */
export interface CatalogCacheWriteResult {
  path: string
  replaced: boolean
  retainedPrevious: boolean
}

/**
 * Atomically replace the cache entry for an identity.
 *
 * The new entry is written to a same-directory temporary file and renamed over
 * the target, so a concurrent reader never observes a partial file. An older or
 * non-authoritative observation never replaces an existing complete-good entry:
 * the previous bytes are retained as last-known-good.
 */
export async function writeCatalogCache(input: {
  directory: string
  identity: CatalogCacheIdentity
  snapshot: CatalogSnapshot
  writtenAt: string
  status: CatalogSourceStatus
  completeness: CatalogSourceCompleteness
}): Promise<CatalogCacheWriteResult> {
  assertIdentity(input.identity)
  await mkdir(input.directory, { recursive: true })
  const path = catalogCachePath(input.directory, input.identity)
  const existing = await readCatalogCache(input)

  if (existing && shouldRetainPrevious(existing, input)) {
    return { path, replaced: false, retainedPrevious: true }
  }

  const entry: CatalogCacheEntry = {
    schemaVersion: 1,
    identity: {
      sourceId: input.identity.sourceId,
      endpoint: input.identity.endpoint,
      ...(input.identity.scopeId === undefined ? {} : { scopeId: input.identity.scopeId }),
      ...(input.identity.credentialScope === undefined
        ? {}
        : { credentialScope: input.identity.credentialScope }),
    },
    revision: input.snapshot.revision,
    observedAt: input.snapshot.observedAt,
    writtenAt: input.writtenAt,
    status: input.status,
    completeness: input.completeness,
    snapshot: input.snapshot,
  }

  const tempPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2)}`
  await writeFile(tempPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
  return { path, replaced: existing !== undefined, retainedPrevious: false }
}

function shouldRetainPrevious(
  existing: CatalogCacheEntry,
  incoming: {
    snapshot: CatalogSnapshot
    status: CatalogSourceStatus
    completeness: CatalogSourceCompleteness
  },
): boolean {
  const existingGood = existing.status === 'ok' && existing.completeness === 'complete'
  const incomingGood = incoming.status === 'ok' && incoming.completeness === 'complete'
  if (existingGood && !incomingGood) return true
  // Never let a late, older observation overwrite a newer published snapshot.
  return Date.parse(existing.observedAt) > Date.parse(incoming.snapshot.observedAt)
}

function decodeCatalogCacheEntry(
  raw: string,
  identity: CatalogCacheIdentity,
): CatalogCacheEntry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Partial<CatalogCacheEntry>
  if (record.schemaVersion !== 1) return undefined
  if (!record.snapshot || typeof record.snapshot !== 'object') return undefined
  if (typeof record.revision !== 'string' || record.revision.length === 0) return undefined
  if (typeof record.observedAt !== 'string' || record.observedAt.length === 0) return undefined
  const stored = record.identity
  if (!stored || typeof stored !== 'object') return undefined
  if (stored.sourceId !== identity.sourceId || stored.endpoint !== identity.endpoint) return undefined
  if ((stored.scopeId ?? undefined) !== (identity.scopeId ?? undefined)) return undefined
  if ((stored.credentialScope ?? undefined) !== (identity.credentialScope ?? undefined)) return undefined
  return record as CatalogCacheEntry
}

function assertIdentity(identity: CatalogCacheIdentity): void {
  if (typeof identity.sourceId !== 'string' || identity.sourceId.length === 0) {
    throw new Error('Catalog cache identity requires a non-empty sourceId.')
  }
  if (typeof identity.endpoint !== 'string' || identity.endpoint.length === 0) {
    throw new Error('Catalog cache identity requires a non-empty endpoint.')
  }
}
