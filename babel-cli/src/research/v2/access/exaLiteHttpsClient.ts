import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as nodeHttpsRequest, type RequestOptions } from 'node:https'

export type ExaLiteHttpsRequestFn = (
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest

let requestImpl: ExaLiteHttpsRequestFn = nodeHttpsRequest

export function exaLiteHttpsRequest(
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
): ClientRequest {
  return requestImpl(url, options, callback)
}

/** Test seam — restores automatically when tests pass a mock and call reset. */
export function setExaLiteHttpsRequestForTests(impl: ExaLiteHttpsRequestFn | null): void {
  requestImpl = impl ?? nodeHttpsRequest
}
