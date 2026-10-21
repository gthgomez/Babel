import { request as nodeHttpsRequest, type ClientRequest, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'

type HttpsRequestFn = (
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest

let requestImpl: HttpsRequestFn = nodeHttpsRequest

export function exaLiteHttpsRequest(
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
): ClientRequest {
  return requestImpl(url, options, callback)
}

/** Test seam — restores automatically when tests pass a mock and call reset. */
export function setExaLiteHttpsRequestForTests(impl: HttpsRequestFn | null): void {
  requestImpl = impl ?? nodeHttpsRequest
}
