import { request as httpsRequest, type IncomingMessage, type RequestOptions } from 'node:https'
import type { LookupFunction } from 'node:net'
import {
  AdmittedNetworkPolicyError,
  assertPublicNetworkTarget,
  parseAdmittedHttpUrl,
  type PublicNetworkTarget,
} from './admittedHttpGet.js'

export const EXA_LITE_API_SEARCH_URL = 'https://api.exa.ai/search'
export const EXA_LITE_API_HOSTNAME = 'api.exa.ai'

export interface AdmittedExaLiteHttpsPostResult {
  ok: boolean
  status: number
  bodyText: string
  requestedUrl: string
  finalUrl: string
}

export type AdmittedExaLiteHttpsPostDispatch = (params: {
  url: URL
  target: PublicNetworkTarget
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  timeoutMs: number
}) => Promise<{ status: number; headers: IncomingMessage['headers']; bodyText: string }>

function assertExaApiHostname(url: URL): void {
  const host = url.hostname.toLowerCase()
  if (host !== EXA_LITE_API_HOSTNAME) {
    throw new AdmittedNetworkPolicyError(
      `Exa search credential may only be sent to ${EXA_LITE_API_HOSTNAME} (got ${host}).`,
    )
  }
}

function readBodyText(response: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    response.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= maxBytes) {
        chunks.push(chunk)
      }
    })
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
  })
}

function defaultDispatch(
  url: URL,
  target: PublicNetworkTarget,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; headers: IncomingMessage['headers']; bodyText: string }> {
  const pinned = target.addresses
  const lookupFn: LookupFunction | undefined =
    pinned && pinned.length > 0
      ? ((hostname, _options, callback) => {
          const cb = callback as (
            error: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void
          if (hostname.toLowerCase() !== target.hostname) {
            cb(new Error('pinned lookup hostname mismatch'), '', 0)
            return
          }
          const first = pinned[0]!
          cb(null, first.address, first.family)
        }) as LookupFunction
      : undefined

  const options: RequestOptions = {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    ...(lookupFn ? { lookup: lookupFn } : {}),
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AdmittedNetworkPolicyError('search aborted before connect'))
      return
    }
    const onAbort = () => req.destroy(new AdmittedNetworkPolicyError('search aborted'))
    signal.addEventListener('abort', onAbort, { once: true })

    const req = httpsRequest(url, options, async (response) => {
      try {
        const bodyText = await readBodyText(response, 2_000_000)
        signal.removeEventListener('abort', onAbort)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, bodyText })
      } catch (err) {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP request timed out')))
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.write(body)
    req.end()
  })
}

/**
 * Admission-aware HTTPS JSON POST locked to api.exa.ai (no cross-host redirects).
 * API key is supplied by caller and must not be logged.
 */
export async function admittedExaLiteHttpsPost(params: {
  apiKey: string
  jsonBody: Record<string, unknown>
  signal: AbortSignal
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  maxBytes?: number
  dispatch?: AdmittedExaLiteHttpsPostDispatch
}): Promise<AdmittedExaLiteHttpsPostResult> {
  const env = params.env ?? process.env
  const url = parseAdmittedHttpUrl(EXA_LITE_API_SEARCH_URL, env)
  assertExaApiHostname(url)
  const target = await assertPublicNetworkTarget(url, env)
  const dispatch = params.dispatch ?? defaultDispatch
  const body = JSON.stringify(params.jsonBody)
  const response = await dispatch({
    url,
    target,
    headers: { 'x-api-key': params.apiKey },
    body,
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? 15_000,
  })

  const location = response.headers.location
  if (location && response.status >= 300 && response.status < 400) {
    throw new AdmittedNetworkPolicyError(
      'Exa search refused HTTP redirect (credential must not leave api.exa.ai).',
    )
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    bodyText: response.bodyText,
    requestedUrl: EXA_LITE_API_SEARCH_URL,
    finalUrl: url.href,
  }
}
