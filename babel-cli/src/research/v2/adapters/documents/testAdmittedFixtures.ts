import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { SourceRevision } from '../../contracts/sources.js'

export function buildSourceRevision(
  sourceId: string,
  revisionId: string,
  contentHash: string,
): SourceRevision {
  return {
    revision_id: revisionId,
    source_id: sourceId,
    content_hash: contentHash,
    retrieved_at: '2026-10-21T00:00:00.000Z',
    extraction_version: 'fixture-admission/0.1.0',
    media_type: 'text/plain',
    completeness: 'complete',
  }
}

export function buildAdmittedContent(
  operationId: string,
  sourceId: string,
  revisionId: string,
  bytes: Buffer,
  mediaType: string,
  opts?: {
    corruptPayloadHash?: boolean
    corruptRevisionHash?: boolean
    wrongSourceId?: string
    requestedUrl?: string
    finalUrl?: string
    redirectChain?: string[]
  },
): AdmittedContent {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const payloadHash = opts?.corruptPayloadHash ? '0'.repeat(64) : hash
  const revisionHash = opts?.corruptRevisionHash ? 'f'.repeat(64) : hash
  const revisionSourceId = opts?.wrongSourceId ?? sourceId
  const requestedUrl = opts?.requestedUrl ?? 'https://example.invalid/source'
  const finalUrl = opts?.finalUrl ?? requestedUrl
  const redirectChain =
    opts?.redirectChain ?? (finalUrl === requestedUrl ? [requestedUrl] : [requestedUrl, finalUrl])
  return {
    operation_id: operationId,
    revision: buildSourceRevision(revisionSourceId, revisionId, revisionHash),
    media_type: mediaType,
    provenance: {
      requested_url: requestedUrl,
      final_url: finalUrl,
      redirect_chain: redirectChain,
    },
    payload: {
      mode: 'inline_bytes',
      bytes_base64: bytes.toString('base64'),
      byte_length: bytes.length,
      content_hash: payloadHash,
    },
  }
}
