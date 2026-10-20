import type { SourceClass } from './sourceAccessPort.js'
import type { SourceAccessPort } from './sourceAccessPort.js'
import type { SourceRecord } from '../contracts/sources.js'

export interface SourceDiscoverRequest {
  operationId: string
  query: string
  signal: AbortSignal
}

export interface SourceDiscoverResult {
  operationId: string
  candidates: SourceRecord[]
}

/**
 * Profile-specific discovery/read facade. All IO goes through SourceAccessPort.
 */
export interface SourceAdapter {
  readonly adapterId: string
  readonly supportedKinds: readonly SourceClass[]
  discover(request: SourceDiscoverRequest, access: SourceAccessPort): Promise<SourceDiscoverResult>
}

export interface SourceAdapterRegistry {
  getAdapter(adapterId: string): SourceAdapter | undefined
  listAdapters(): readonly SourceAdapter[]
}
