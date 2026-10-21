import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { exaLiteHttpsRequest } from './exaLiteHttpsClient.js'
import {
  AdmittedNetworkPolicyError,
  assertPublicNetworkTarget,
  buildPinnedLookup,
  parseAdmittedHttpUrl,
  type PublicNetworkTarget,
} from './admittedHttpGet.js'
import {
  assertOperationSignalActive,
  createLinkedOperationAbort,
} from './exaLiteOperationAbort.js'

export const EXA_LITE_API_SEARCH_URL = 'https://api.exa.ai/search'
export const EXA_LITE_API_HOSTNAME = 'api.exa.ai'

export const DEFAULT_EXA_LITE_RESPONSE_MAX_BYTES = 512_000

export interface AdmittedExaLiteHttpsPostResult {
  ok: boolean
  status: number
  bodyText: string
  requestedUrl: string
  finalUrl: string
  bodyTruncated: boolean
}

export interface AdmittedExaLiteHttpsPostDispatchParams {
  url: URL
  target: PublicNetworkTarget
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  timeoutMs: number
  maxBytes: number
}

export type AdmittedExaLiteHttpsPostDispatch = (
  params: AdmittedExaLiteHttpsPostDispatchParams,
) => Promise<{ status: number; headers: IncomingMessage['headers']; bodyText: string }>

export type ExaLiteAdmissionTargetResolver = (
  url: URL,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<PublicNetworkTarget>

function assertExaApiHostname(url: URL): void {
  const host = url.hostname.toLowerCase()
  if (host !== EXA_LITE_API_HOSTNAME) {
    throw new AdmittedNetworkPolicyError(
      `Exa search credential may only be sent to ${EXA_LITE_API_HOSTNAME} (got ${host}).`,
    )
  }
}

function readBodyText(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      response.destroy()
      reject(err)
    }

    const onAbort = () => fail(new AdmittedNetworkPolicyError('search aborted'))
    signal.addEventListener('abort', onAbort, { once: true })

    response.on('data', (chunk: Buffer) => {
      if (signal.aborted) {
        fail(new AdmittedNetworkPolicyError('search aborted'))
        return
      }
      total += chunk.length
      if (total > maxBytes) {
        signal.removeEventListener('abort', onAbort)
        fail(new AdmittedNetworkPolicyError('response body exceeds configured maxBytes'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    response.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      fail(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

export function defaultAdmittedExaLiteHttpsPostDispatch(
  params: AdmittedExaLiteHttpsPostDispatchParams,
): Promise<{ status: number; headers: IncomingMessage['headers']; bodyText: string }> {
  const { url, target, headers, body, signal, timeoutMs, maxBytes } = params
  if (signal.aborted) {
    return Promise.reject(new AdmittedNetworkPolicyError('search aborted before connect'))
  }

  const lookupFn = buildPinnedLookup(target)

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
    let req: ClientRequest | undefined
    let res: IncomingMessage | undefined

    const tearDown = (err: Error) => {
      if (res && typeof res.destroy === 'function') {
        res.destroy()
      }
      req?.destroy(err)
    }

    const onAbort = () => tearDown(new AdmittedNetworkPolicyError('search aborted'))
    signal.addEventListener('abort', onAbort, { once: true })

    req = exaLiteHttpsRequest(url, options, async (response) => {
      res = response
      try {
        const bodyText = await readBodyText(response, maxBytes, signal)
        signal.removeEventListener('abort', onAbort)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, bodyText })
      } catch (err) {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    })

    req.setTimeout(timeoutMs, () => tearDown(new Error('HTTP request timed out')))
    req.on('error', (err: Error) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.write(body)
    req.end()
  })
}

async function defaultAdmissionTargetResolver(
  url: URL,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<PublicNetworkTarget> {
  assertOperationSignalActive(signal, 'DNS admission')
  const target = await assertPublicNetworkTarget(url, env)
  assertOperationSignalActive(signal, 'DNS admission')
  return target
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
  admissionTargetResolver?: ExaLiteAdmissionTargetResolver
}): Promise<AdmittedExaLiteHttpsPostResult> {
  const env = params.env ?? process.env
  const deadlineMs = params.timeoutMs ?? 15_000
  const maxBytes = params.maxBytes ?? DEFAULT_EXA_LITE_RESPONSE_MAX_BYTES
  const started = Date.now()
  const remainingMs = () => Math.max(0, deadlineMs - (Date.now() - started))
  const linked = createLinkedOperationAbort(params.signal, deadlineMs)

  try {
    const url = parseAdmittedHttpUrl(EXA_LITE_API_SEARCH_URL, env)
    assertExaApiHostname(url)
    const resolveTarget = params.admissionTargetResolver ?? defaultAdmissionTargetResolver
    const target = await resolveTarget(url, env, linked.signal)

    assertOperationSignalActive(linked.signal, 'HTTPS POST')
    const dispatch = params.dispatch ?? defaultAdmittedExaLiteHttpsPostDispatch
    const body = JSON.stringify(params.jsonBody)
    const response = await dispatch({
      url,
      target,
      headers: { 'x-api-key': params.apiKey },
      body,
      signal: linked.signal,
      timeoutMs: remainingMs(),
      maxBytes,
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
      bodyTruncated: false,
    }
  } finally {
    linked.dispose()
  }
}
