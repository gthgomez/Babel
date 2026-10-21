import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import {
  evaluateNetworkHostPolicy,
  formatEnterprisePolicyDecision,
} from '../../../config/enterprisePolicy.js'
import { isPrivateNetworkAddress } from '../../../tools/webContext.js'

const MAX_REDIRECTS = 8

export interface ResolvedNetworkAddress {
  address: string
  family: 4 | 6
}

export interface PublicNetworkTarget {
  hostname: string
  addresses: ResolvedNetworkAddress[] | null
}

export interface AdmittedHttpGetResult {
  ok: boolean
  status: number
  contentType: string
  buffer: Buffer
  bytesReceived: number
  truncated: boolean
  requestedUrl: string
  finalUrl: string
  redirectChain: string[]
  /** Final-hop response headers (wire names lowercased; values as received). */
  responseHeaders: Record<string, string | string[] | undefined>
}

export class AdmittedNetworkPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdmittedNetworkPolicyError'
  }
}

function allowsPrivateNetworkFetch(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BABEL_WEB_ALLOW_PRIVATE === '1'
}

/** Scheme + enterprise host policy (shared with governed web fetch). */
export function parseAdmittedHttpUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): URL {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AdmittedNetworkPolicyError(
      `Unsupported URL protocol "${parsed.protocol}". Only http/https are allowed.`,
    )
  }
  const policyDecision = evaluateNetworkHostPolicy(parsed.hostname)
  if (!policyDecision.allowed) {
    throw new AdmittedNetworkPolicyError(formatEnterprisePolicyDecision(policyDecision))
  }
  return parsed
}

export async function assertPublicNetworkTarget(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicNetworkTarget> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (allowsPrivateNetworkFetch(env)) {
    return { hostname, addresses: null }
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new AdmittedNetworkPolicyError(
      'Localhost web fetches are blocked by default. Set BABEL_WEB_ALLOW_PRIVATE=1 for explicit local debugging.',
    )
  }

  if (isPrivateNetworkAddress(hostname)) {
    throw new AdmittedNetworkPolicyError(
      `Private network web fetch blocked for ${hostname}. Set BABEL_WEB_ALLOW_PRIVATE=1 for explicit local debugging.`,
    )
  }

  const literalKind = isIP(hostname)
  if (literalKind === 4 || literalKind === 6) {
    return {
      hostname,
      addresses: [{ address: hostname, family: literalKind }],
    }
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true })
  const blocked = addresses.find((entry) => isPrivateNetworkAddress(entry.address))
  if (blocked) {
    throw new AdmittedNetworkPolicyError(
      `Private network web fetch blocked after DNS resolution for ${hostname} -> ${blocked.address}.`,
    )
  }

  return {
    hostname,
    addresses: addresses.map((entry) => ({
      address: entry.address,
      family: entry.family === 6 ? 6 : 4,
    })),
  }
}

function buildPinnedLookup(target: PublicNetworkTarget): LookupFunction | undefined {
  if (!target.addresses || target.addresses.length === 0) {
    return undefined
  }
  const pinned = target.addresses
  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      error: NodeJS.ErrnoException | null,
      address: string | ResolvedNetworkAddress[],
      family?: number,
    ) => void
    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      Boolean((options as { all?: boolean }).all)
    if (hostname.replace(/^\[|\]$/g, '').toLowerCase() !== target.hostname) {
      cb(new Error(`Pinned DNS lookup refused unexpected hostname: ${hostname}`), '', 0)
      return
    }
    if (wantsAll) {
      cb(null, pinned)
      return
    }
    const first = pinned[0]!
    cb(null, first.address, first.family)
  }) as LookupFunction
}

function readStreamingBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ buffer: Buffer; bytesReceived: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytesReceived = 0
    let bufferedBytes = 0
    let truncated = false
    let settled = false

    function finish(): void {
      if (settled) return
      settled = true
      resolve({
        buffer: Buffer.concat(chunks),
        bytesReceived,
        truncated,
      })
    }

    response.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length
      if (bufferedBytes < maxBytes) {
        const remaining = maxBytes - bufferedBytes
        const slice = chunk.subarray(0, remaining)
        chunks.push(slice)
        bufferedBytes += slice.length
      }
      if (bytesReceived > maxBytes) {
        truncated = true
        response.destroy()
      }
    })
    response.on('end', finish)
    response.on('close', finish)
    response.on('error', reject)
  })
}

function singleGet(
  url: URL,
  target: PublicNetworkTarget,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Awaited<ReturnType<typeof readStreamingBody>> }> {
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  const lookupFn = buildPinnedLookup(target)
  const options: RequestOptions = {
    method: 'GET',
    headers: { accept: '*/*' },
    ...(lookupFn ? { lookup: lookupFn } : {}),
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AdmittedNetworkPolicyError('fetch aborted before connect'))
      return
    }
    const onAbort = () => {
      req.destroy(new AdmittedNetworkPolicyError('fetch aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const req = requestFn(url, options, async (response) => {
      try {
        const body = await readStreamingBody(response, maxBytes)
        signal.removeEventListener('abort', onAbort)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
      } catch (err) {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request timed out after ${timeoutMs} ms.`))
    })
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.end()
  })
}

function resolveRedirectLocation(location: string, base: URL): URL {
  return new URL(location, base)
}

/**
 * Governed GET with scheme/enterprise/private-address/DNS admission and redirect re-validation.
 * Enforces maxBytes while streaming (does not buffer the full body before truncation).
 */
export type AdmittedHttpGetDispatch = (
  url: URL,
  target: PublicNetworkTarget,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<{
  status: number
  headers: IncomingMessage['headers']
  body: Awaited<ReturnType<typeof readStreamingBody>>
}>

export async function admittedHttpGet(params: {
  url: string
  maxBytes: number
  signal: AbortSignal
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Invoked before each HTTP dispatch hop (initial URL and each redirect target). */
  assertHopAdmitted?: (url: URL) => void | Promise<void>
  /** Test seam — count and stub HTTP dispatches without live network. */
  dispatchGet?: AdmittedHttpGetDispatch
}): Promise<AdmittedHttpGetResult> {
  const env = params.env ?? process.env
  const requestedUrl = params.url
  let current = parseAdmittedHttpUrl(requestedUrl, env)
  const redirectChain: string[] = [current.href]
  const timeoutMs = params.timeoutMs ?? 15_000
  const dispatchGet = params.dispatchGet ?? singleGet

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    current = parseAdmittedHttpUrl(current.href, env)
    if (params.assertHopAdmitted) {
      await params.assertHopAdmitted(current)
    }
    const target = await assertPublicNetworkTarget(current, env)
    const response = await dispatchGet(current, target, params.maxBytes, params.signal, timeoutMs)
    const status = response.status
    if (status >= 300 && status < 400) {
      const locationRaw = response.headers.location
      const location = Array.isArray(locationRaw) ? locationRaw[0] : locationRaw
      if (!location) {
        throw new AdmittedNetworkPolicyError(`HTTP ${status} redirect without Location header`)
      }
      if (hop >= MAX_REDIRECTS) {
        throw new AdmittedNetworkPolicyError('redirect limit exceeded')
      }
      const redirectTarget = resolveRedirectLocation(location, current)
      current = parseAdmittedHttpUrl(redirectTarget.href, env)
      if (params.assertHopAdmitted) {
        await params.assertHopAdmitted(current)
      }
      redirectChain.push(current.href)
      continue
    }

    const contentTypeHeader = response.headers['content-type']
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader.join(', ')
      : (contentTypeHeader ?? 'application/octet-stream')

    return {
      ok: status >= 200 && status < 300,
      status,
      contentType,
      buffer: response.body.buffer,
      bytesReceived: response.body.bytesReceived,
      truncated: response.body.truncated,
      requestedUrl,
      finalUrl: current.href,
      redirectChain,
      responseHeaders: response.headers,
    }
  }

  throw new AdmittedNetworkPolicyError('redirect limit exceeded')
}

/** Default HTTP dispatch for {@link admittedHttpGet} (test/diagnostic seam). */
export const defaultAdmittedHttpGetDispatch: AdmittedHttpGetDispatch = singleGet
