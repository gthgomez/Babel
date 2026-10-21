import type { ResearchMissionV2 } from '../contracts/mission.js'

export const PRODUCTION_CLI_DOCUMENT_HOST_WIRE_BYTES_ENV =
  'BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES'
export const PRODUCTION_CLI_DOCUMENT_HOST_DECOMPRESSED_BYTES_ENV =
  'BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES'

export interface ProductionCliDocumentHostByteCeilings {
  maxDocumentWireBytes: number
  maxDocumentDecompressedBytes: number
}

function parsePositiveSafeIntEnv(raw: string | undefined, envName: string): number | undefined {
  if (!raw?.trim()) return undefined
  if (raw !== raw.trim()) {
    throw new Error(`${envName} must be a positive safe integer (got ${raw})`)
  }
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envName} must be a positive safe integer (got ${raw})`)
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${envName} must be a positive safe integer (got ${raw})`)
  }
  return value
}

/**
 * Optional production CLI host ceilings for mission-selected admitted documents only.
 * Unset → document fetches use the same host caps as general web (`DEFAULT_MAX_ADMITTED_BYTES`).
 * When set, both wire and decompressed env vars are required; values still intersect mission
 * `admitted_document_sources` budgets on each fetch (lower ceiling wins).
 */
export function resolveProductionCliDocumentHostByteCeilings(
  env: NodeJS.ProcessEnv = process.env,
): ProductionCliDocumentHostByteCeilings | undefined {
  const wire = parsePositiveSafeIntEnv(
    env[PRODUCTION_CLI_DOCUMENT_HOST_WIRE_BYTES_ENV],
    PRODUCTION_CLI_DOCUMENT_HOST_WIRE_BYTES_ENV,
  )
  const decoded = parsePositiveSafeIntEnv(
    env[PRODUCTION_CLI_DOCUMENT_HOST_DECOMPRESSED_BYTES_ENV],
    PRODUCTION_CLI_DOCUMENT_HOST_DECOMPRESSED_BYTES_ENV,
  )
  if (wire === undefined && decoded === undefined) {
    return undefined
  }
  if (wire === undefined || decoded === undefined) {
    throw new Error(
      `production document acquisition requires both ${PRODUCTION_CLI_DOCUMENT_HOST_WIRE_BYTES_ENV} and ${PRODUCTION_CLI_DOCUMENT_HOST_DECOMPRESSED_BYTES_ENV}`,
    )
  }
  return { maxDocumentWireBytes: wire, maxDocumentDecompressedBytes: decoded }
}

/** Max declared mission document budgets (for docs / operator sanity checks only). */
export function maxMissionAdmittedDocumentByteBudgets(
  mission: ResearchMissionV2,
): { maxWire: number; maxDecompressed: number } | undefined {
  const entries = mission.source_policy.admitted_document_sources ?? []
  if (entries.length === 0) return undefined
  let maxWire = 0
  let maxDecompressed = 0
  for (const entry of entries) {
    maxWire = Math.max(maxWire, entry.wire_byte_budget)
    maxDecompressed = Math.max(maxDecompressed, entry.decompressed_byte_budget)
  }
  return { maxWire, maxDecompressed }
}
