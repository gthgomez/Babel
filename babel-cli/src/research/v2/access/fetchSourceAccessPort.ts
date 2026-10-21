import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../contracts/admittedContent.js'
import type { SourceRevision } from '../contracts/sources.js'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceFetchResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import {
  parsePinnedGithubBlobUrl,
  assertImmutableRawUrlForPinnedBlob,
  pinnedGithubBlobUrlToRawContentUrl,
  assertRepositoryFileTransportHopMatchesPin,
  TechnicalRepositoryPinError,
} from '../profiles/technical/repositoryFilePinning.js'
import {
  AdmittedNetworkPolicyError,
  admittedHttpGet,
  type AdmittedHttpGetDispatch,
  type AdmittedHttpGetResult,
} from './admittedHttpGet.js'
import { validateDocumentFetchUrlForMission } from './missionDocumentAdmission.js'
import {
  validateMissionFetchAdmission,
  validateMissionWebHopUrl,
} from './missionSourceAdmission.js'
import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import {
  SourceAcquisitionDiagnosticsSchema,
  sanitizeAcquisitionUrl,
} from '../contracts/sourceAcquisitionDiagnostics.js'
import { acquisitionDiagnosticsFromHttpGet } from './sourceAcquisitionDiagnosticsFromHttp.js'
import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'
import {
  assertDocumentPolicyFetchUrl,
  assertDocumentPolicyFinalUrl,
  assertDocumentPolicyRedirectHop,
  intersectDocumentFetchByteBudgets,
  resolveMissionDocumentPolicyForFetchUrl,
  verifyMissionAdmittedDocumentBody,
} from './missionDocumentAcquisitionPolicy.js'

export type AdmittedHttpGetFn = (params: {
  url: string
  maxBytes: number
  maxWireBytes?: number
  maxDecodedBytes?: number
  signal: AbortSignal
  assertHopAdmitted?: (url: URL) => void | Promise<void>
}) => Promise<AdmittedHttpGetResult>

export interface FetchSourceAccessPortOptions {
  /** Production path: governed network GET. Tests inject a stub instead of live HTTP. */
  admittedGet?: AdmittedHttpGetFn
  /** Host decoded/decompressed ceiling for general/web/repository fetch (not document-policy). */
  maxDecompressedBytes?: number
  /** Injected transport for the default admittedHttpGet wrapper (tests only). */
  dispatchGet?: AdmittedHttpGetDispatch
  /** General/web/repository wire ceiling; documents use {@link maxDocumentWireBytes} when set. */
  maxAdmittedBytes?: number
  /** Mission-selected admitted document wire ceiling (intersected with mission budgets). */
  maxDocumentWireBytes?: number
  /** Mission-selected admitted document decompressed ceiling (intersected with mission budgets). */
  maxDocumentDecompressedBytes?: number
  /** When set, enforce mission source classes, pins, and redirect-hop domain policy before dispatch. */
  mission?: ResearchMissionV2
}

export const DEFAULT_MAX_ADMITTED_BYTES = 200_000

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function issueRevisionId(sourceId: string, contentHash: string): string {
  return `rev-${sourceId}-${contentHash.slice(0, 16)}`
}

function minimalAcquisitionDiagnostics(
  attemptedUrl: string,
  sourceId: string,
): SourceAcquisitionDiagnostics {
  return SourceAcquisitionDiagnosticsSchema.parse({
    evidence_role: 'attempted_source',
    source_id: sourceId,
    attempted_url: sanitizeAcquisitionUrl(attemptedUrl),
  })
}

function failedFetch(
  operationId: string,
  failureCategory: SourceAccessFailureCategory,
  message: string,
  acquisition_diagnostics?: SourceAcquisitionDiagnostics,
): SourceFetchResult {
  return {
    operationId,
    status: 'failed',
    failureCategory,
    message,
    ...(acquisition_diagnostics ? { acquisition_diagnostics } : {}),
  }
}

function policyFailureCategory(err: unknown): SourceFetchResult {
  if (err instanceof AdmittedNetworkPolicyError) {
    const message = err.message
    if (/private network|localhost|DNS resolution/i.test(message)) {
      return {
        operationId: '',
        status: 'failed',
        failureCategory: 'private_address_blocked',
        message,
      }
    }
    return {
      operationId: '',
      status: 'failed',
      failureCategory: 'policy_denied',
      message,
    }
  }
  return {
    operationId: '',
    status: 'failed',
    failureCategory: 'network_error',
    message: err instanceof Error ? err.message : String(err),
  }
}

/**
 * Network {@link SourceAccessPort} for admitted byte fetch (GET). Search is not implemented here;
 * profile adapters perform discover via registry + delegated search policies.
 */
export class FetchSourceAccessPort implements SourceAccessPort {
  private readonly admittedGet: AdmittedHttpGetFn

  constructor(private readonly options: FetchSourceAccessPortOptions = {}) {
    const dispatchGet = options.dispatchGet
    this.admittedGet =
      options.admittedGet ??
      ((params) =>
        admittedHttpGet({
          url: params.url,
          maxBytes: params.maxBytes,
          ...(params.maxWireBytes !== undefined ? { maxWireBytes: params.maxWireBytes } : {}),
          ...(params.maxDecodedBytes !== undefined ? { maxDecodedBytes: params.maxDecodedBytes } : {}),
          signal: params.signal,
          ...(params.assertHopAdmitted ? { assertHopAdmitted: params.assertHopAdmitted } : {}),
          ...(dispatchGet ? { dispatchGet } : {}),
        }))
  }

  async search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    return {
      operationId: request.operationId,
      status: 'failed',
      failureCategory: 'search_provider_unavailable',
      message: 'FetchSourceAccessPort does not implement search; use profile adapters + registry',
    }
  }

  async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const observedUrl = request.source.observed_urls[0]
    if (!observedUrl) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'not_found',
        message: 'source has no observed URL',
      }
    }
    let fetchUrl = observedUrl
    let pinnedBlobRef = null
    if (request.source.kind === 'repository_file') {
      pinnedBlobRef = parsePinnedGithubBlobUrl(observedUrl)
      if (!pinnedBlobRef) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: 'repository_file observed URL is not a pinned github blob URL',
        }
      }
      const rawUrl = pinnedGithubBlobUrlToRawContentUrl(observedUrl)
      if (!rawUrl) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: 'repository_file observed URL cannot map to immutable raw content URL',
        }
      }
      try {
        assertImmutableRawUrlForPinnedBlob(observedUrl, rawUrl)
      } catch (err) {
        const message = err instanceof TechnicalRepositoryPinError ? err.message : String(err)
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message,
        }
      }
      fetchUrl = rawUrl
    }
    if (this.options.mission) {
      const denied = validateMissionFetchAdmission(request.source, this.options.mission)
      if (denied) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory:
            denied.failureCategory === 'pin_binding_failed' ? 'policy_denied' : denied.failureCategory,
          message: denied.message,
        }
      }
      const fetchUrlViolation = validateDocumentFetchUrlForMission(
        fetchUrl,
        request.source,
        this.options.mission,
      )
      if (fetchUrlViolation) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: fetchUrlViolation,
        }
      }
    }
    const mission = this.options.mission
    const documentPolicy = resolveMissionDocumentPolicyForFetchUrl(
      request.source,
      mission,
      fetchUrl,
    )
    const defaultHostWire = this.options.maxAdmittedBytes ?? DEFAULT_MAX_ADMITTED_BYTES
    const defaultHostDecoded = this.options.maxDecompressedBytes ?? defaultHostWire
    const hostWireCeiling = documentPolicy
      ? (this.options.maxDocumentWireBytes ?? defaultHostWire)
      : defaultHostWire
    const hostDecodedCeiling = documentPolicy
      ? (this.options.maxDocumentDecompressedBytes ?? defaultHostDecoded)
      : defaultHostDecoded
    if (documentPolicy) {
      const preDispatchViolation = assertDocumentPolicyFetchUrl(fetchUrl, documentPolicy)
      if (preDispatchViolation) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: preDispatchViolation,
        }
      }
    }
    const budgets = intersectDocumentFetchByteBudgets(
      documentPolicy,
      hostWireCeiling,
      hostDecodedCeiling,
    )
    const limit = Math.max(budgets.maxWireBytes, budgets.maxDecodedBytes)
    try {
      const response = await this.admittedGet({
        url: fetchUrl,
        maxBytes: limit,
        maxWireBytes: budgets.maxWireBytes,
        maxDecodedBytes: budgets.maxDecodedBytes,
        signal: request.signal,
        ...(mission
          ? {
              assertHopAdmitted: (hopUrl: URL) => {
                const violation = validateMissionWebHopUrl(hopUrl.href, request.source, mission)
                if (violation) {
                  throw new AdmittedNetworkPolicyError(violation)
                }
                if (documentPolicy) {
                  const hopPolicyViolation = assertDocumentPolicyRedirectHop(
                    hopUrl.href,
                    documentPolicy,
                    mission,
                  )
                  if (hopPolicyViolation) {
                    throw new AdmittedNetworkPolicyError(hopPolicyViolation)
                  }
                }
              },
            }
          : {}),
      })
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!response.ok) {
        return failedFetch(
          request.operationId,
          'network_error',
          `HTTP ${response.status}`,
          acquisitionDiagnosticsFromHttpGet(response, {
            attemptedUrl: fetchUrl,
            sourceId: request.source.source_id,
          }),
        )
      }
      const admittedBytes = response.buffer
      const decodeTruncated = response.transportCoding?.decoded_truncated === true
      const truncated = response.truncated || decodeTruncated
      if (documentPolicy) {
        const finalUrlViolation = assertDocumentPolicyFinalUrl(response.finalUrl, documentPolicy)
        if (finalUrlViolation) {
          return failedFetch(
            request.operationId,
            'policy_denied',
            finalUrlViolation,
            acquisitionDiagnosticsFromHttpGet(response, {
              attemptedUrl: fetchUrl,
              sourceId: request.source.source_id,
            }),
          )
        }
        const bodyAdmission = verifyMissionAdmittedDocumentBody(
          documentPolicy,
          admittedBytes,
          truncated,
        )
        if (!bodyAdmission.ok) {
          return failedFetch(
            request.operationId,
            bodyAdmission.failureCategory,
            bodyAdmission.message,
            acquisitionDiagnosticsFromHttpGet(response, {
              attemptedUrl: fetchUrl,
              sourceId: request.source.source_id,
            }),
          )
        }
      }
      if (admittedBytes.length === 0) {
        return failedFetch(
          request.operationId,
          'empty_body',
          'source has no retrievable bytes',
          acquisitionDiagnosticsFromHttpGet(response, {
            attemptedUrl: fetchUrl,
            sourceId: request.source.source_id,
          }),
        )
      }
      const truncationReason = decodeTruncated
        ? 'host_decoded_byte_limit'
        : response.truncated
          ? 'host_byte_limit'
          : undefined
      const bytesReceivedTotal = decodeTruncated
        ? (response.transportCoding?.decoded_byte_length ?? response.bytesReceived)
        : response.bytesReceived
      const contentHash = sha256(admittedBytes)
      const mediaType = response.contentType.split(';')[0]?.trim() ?? 'application/octet-stream'
      const revision: SourceRevision = {
        revision_id: issueRevisionId(request.source.source_id, contentHash),
        source_id: request.source.source_id,
        content_hash: contentHash,
        retrieved_at: new Date().toISOString(),
        extraction_version: 'fetch-source-access-2',
        media_type: mediaType,
        completeness: truncated ? 'truncated' : 'complete',
        byte_length_received: admittedBytes.byteLength,
        truncation_reason: truncationReason,
      }
      let provenanceUrls: AdmittedContent['provenance']
      if (pinnedBlobRef && request.source.kind === 'repository_file') {
        try {
          for (const hop of [
            response.requestedUrl,
            ...response.redirectChain,
            response.finalUrl,
          ]) {
            assertRepositoryFileTransportHopMatchesPin(hop, pinnedBlobRef)
          }
          provenanceUrls = {
            requested_url: response.requestedUrl,
            final_url: response.finalUrl,
            redirect_chain: response.redirectChain,
            repository_file_pin: { pinned_blob_url: observedUrl },
            ...(response.transportCoding
              ? { http_content_coding: response.transportCoding }
              : {}),
          }
        } catch (err) {
          const message = err instanceof TechnicalRepositoryPinError ? err.message : String(err)
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'policy_denied',
            message,
          }
        }
      } else {
        provenanceUrls = {
          requested_url: response.requestedUrl,
          final_url: response.finalUrl,
          redirect_chain: response.redirectChain,
          ...(response.transportCoding
            ? { http_content_coding: response.transportCoding }
            : {}),
        }
      }
      const admitted: AdmittedContent = {
        operation_id: request.operationId,
        revision,
        media_type: mediaType,
        provenance: provenanceUrls,
        payload: {
          mode: 'inline_bytes',
          bytes_base64: admittedBytes.toString('base64'),
          byte_length: admittedBytes.byteLength,
          content_hash: contentHash,
        },
        ...(truncated
          ? {
              truncation: {
                reason: truncationReason ?? 'host_byte_limit',
                bytes_received: bytesReceivedTotal,
                bytes_limit: budgets.maxDecodedBytes,
              },
            }
          : {}),
      }
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      return { operationId: request.operationId, status: 'ok', admitted }
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      const mapped = policyFailureCategory(err)
      return { ...mapped, operationId: request.operationId }
    }
  }
}
