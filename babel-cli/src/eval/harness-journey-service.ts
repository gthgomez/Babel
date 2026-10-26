/** Owned loopback service for independent research/effect observations. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'

export interface JourneyServiceSnapshot {
  records: Record<string, { id: string; status: string; conclusion?: string }>
  followups: { id: string; caseId: string; operationId: string }[]
  writes: { sequence: number; operationId: string; target: string; reply: 'sent' | 'lost'; value: unknown }[]
  recordReads: { sequence: number; recordId: string; value: { id: string; status: string; conclusion?: string } }[]
  lookups: { sequence: number; operationId: string; found: boolean }[]
  sourceReads: { sequence: number; sourceId: string; sha256: string; text: string }[]
  createAttempts: number
}
export interface JourneyService {
  readonly baseUrl: string
  snapshot(): JourneyServiceSnapshot
  close(): Promise<void>
}

class RequestError extends Error {
  constructor(readonly status: number) { super('Invalid fixture request') }
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    // Drain, rather than destroying the connection before a 413 can be sent.
    if (size <= 16_384) chunks.push(bytes)
    if (size > 1_048_576) throw new RequestError(413)
  }
  if (size > 16_384) throw new RequestError(413)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RequestError(400) }
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

/**
 * Binds only 127.0.0.1 on an ephemeral port. State/receipts belong to the host,
 * never to candidate-supplied success flags. Synthetic service authorization
 * remains the candidate harness's responsibility; adjacent records deliberately
 * exist so an unauthorized effect can be detected, not hidden by the fixture.
 */
export async function startJourneyService(options: {
  sources: Readonly<Record<string, string>>
  unavailableOnce?: readonly string[]
  dropFirstCreateReply?: boolean
  statePath?: string
}): Promise<JourneyService> {
  const sources = new Map(Object.entries(options.sources))
  const statePath = options.statePath
  const unavailable = new Set(options.unavailableOnce ?? [])
  let dropNextCreate = options.dropFirstCreateReply === true
  const state: JourneyServiceSnapshot = {
    records: { 'demo-42': { id: 'demo-42', status: 'new' }, 'demo-43': { id: 'demo-43', status: 'new' } },
    followups: [], writes: [], recordReads: [], lookups: [], sourceReads: [], createAttempts: 0,
  }
  const operations = new Map<string, { payload: string; result: unknown }>()
  let sequence = 0
  let healthy = true
  let baseUrl = ''
  let pending = Promise.resolve()
  async function persist(): Promise<void> {
    if (!statePath) return
    const next = `${statePath}.${randomUUID()}.next`
    await writeFile(next, JSON.stringify(state, null, 2), { flag: 'wx' })
    await rename(next, statePath)
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', baseUrl)
    if (!healthy) { reply(response, 503, { error: 'fixture_state_unavailable' }); return }
    if (url.origin !== baseUrl || request.headers.host !== new URL(baseUrl).host || request.headers.origin) {
      reply(response, 403, { error: 'fixture_origin_denied' }); return
    }
    const current = ++sequence
    const source = /^\/sources\/([a-z0-9-]+)$/.exec(url.pathname)?.[1]
    if (request.method === 'GET' && source) {
      const text = sources.get(source)
      if (text === undefined) { reply(response, 404, { error: 'source_not_found' }); return }
      if (unavailable.delete(source)) { reply(response, 503, { error: 'source_unavailable' }); return }
      state.sourceReads.push({ sequence: current, sourceId: source, sha256: createHash('sha256').update(text).digest('hex'), text })
      await persist()
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end(text)
      return
    }
    const operation = /^\/operations\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname)?.[1]
    if (request.method === 'GET' && operation) {
      const found = operations.get(operation)
      state.lookups.push({ sequence: current, operationId: operation, found: !!found })
      await persist()
      reply(response, found ? 200 : 404, found?.result ?? { error: 'operation_not_found' })
      return
    }
    const recordId = /^\/records\/(demo-4[23])$/.exec(url.pathname)?.[1]
    if (request.method === 'GET' && recordId) {
      state.recordReads.push({ sequence: current, recordId, value: structuredClone(state.records[recordId]!) })
      await persist()
      reply(response, 200, state.records[recordId]); return
    }
    if (!((request.method === 'PATCH' && recordId) || (request.method === 'POST' && url.pathname === '/followups'))) {
      reply(response, 404, { error: 'route_not_found' }); return
    }
    const operationId = request.headers['x-operation-id']
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new RequestError(400)
    const payload = await body(request)
    const parsed = request.method === 'PATCH'
      ? z.object({ status: z.enum(['new', 'reviewed']).optional(), conclusion: z.string().min(1).max(2000).optional() }).strict().refine(value => value.status !== undefined || value.conclusion !== undefined).safeParse(payload)
      : z.object({ caseId: z.enum(['demo-42', 'demo-43']) }).strict().safeParse(payload)
    if (!parsed.success) throw new RequestError(400)
    const fingerprint = JSON.stringify({ method: request.method, path: url.pathname, body: parsed.data })
    if (request.method === 'POST') state.createAttempts++
    const existing = operations.get(operationId)
    if (existing) {
      await persist()
      reply(response, existing.payload === fingerprint ? 200 : 409, existing.payload === fingerprint ? existing.result : { error: 'operation_identity_conflict' })
      return
    }
    let result: unknown
    if (request.method === 'PATCH' && recordId) {
      const patch = z.object({ status: z.enum(['new', 'reviewed']).optional(), conclusion: z.string().optional() }).parse(parsed.data)
      const record = state.records[recordId]!
      Object.assign(record, patch)
      result = structuredClone(record)
    } else {
      const { caseId } = z.object({ caseId: z.string() }).parse(parsed.data)
      const record = { id: `followup-${state.followups.length + 1}`, caseId, operationId }
      state.followups.push(record)
      result = structuredClone(record)
    }
    operations.set(operationId, { payload: fingerprint, result })
    const loseReply = request.method === 'POST' && dropNextCreate
    if (loseReply) dropNextCreate = false
    state.writes.push({ sequence: current, operationId, target: recordId ?? '/followups', reply: loseReply ? 'lost' : 'sent', value: structuredClone(result) })
    await persist()
    if (loseReply) { request.socket.destroy(); return }
    reply(response, request.method === 'POST' ? 201 : 200, result)
  }
  const server = createServer((request, response) => {
    // Serialize requests so stable identity comparison, commit and readback
    // form one order even when two clients arrive concurrently.
    pending = pending.then(async () => {
      try { await handle(request, response) } catch (error) {
        if (!(error instanceof RequestError)) healthy = false
        if (!response.destroyed) reply(response, error instanceof RequestError ? error.status : 500, { error: 'fixture_request_failed' })
      }
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.setTimeout(5000, socket => socket.destroy())
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback fixture failed to bind')
  baseUrl = `http://127.0.0.1:${address.port}`
  try {
    if (statePath) await writeFile(statePath, JSON.stringify(state, null, 2), { flag: 'wx' })
  } catch (error) {
    await new Promise<void>(accept => server.close(() => accept()))
    throw error
  }
  let closing: Promise<void> | null = null
  return {
    baseUrl,
    snapshot: () => structuredClone(state),
    close() {
      closing ??= (async () => {
        server.closeAllConnections()
        await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
        await pending
      })()
      return closing
    },
  }
}
