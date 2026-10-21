import type { SourceSearchProviderReceipt } from '../../contracts/sourceSearchProviderReceipt.js'
import { mergeDiscoverSearchReceipts } from '../../engine/sourceDiscoverSearchReceipt.js'
import type { SourceDiscoverResult } from '../../ports/sourceAdapter.js'
import type { SourceSearchResult } from '../../ports/sourceAccessPort.js'

export function receiptFromSourceSearchResult(
  search: SourceSearchResult,
): SourceSearchProviderReceipt | undefined {
  if (search.status === 'ok' || search.status === 'failed') {
    return mergeDiscoverSearchReceipts(search.receipt)
  }
  return undefined
}

export function cancelledDiscoverResult(
  operationId: string,
  receipt?: SourceSearchProviderReceipt,
): SourceDiscoverResult {
  return {
    operationId,
    status: 'cancelled',
    ...(receipt ? { search_provider_receipt: receipt } : {}),
  }
}
