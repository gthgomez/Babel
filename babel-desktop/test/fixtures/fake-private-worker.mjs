// Protocol fixture for private-worker-run.test.mjs. Speaks the JSON-RPC worker
// surface over descriptors 3/4 and never calls a provider.
import { Socket } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const input = new Socket({ fd: 3, readable: true, writable: false })
const output = new Socket({ fd: 4, readable: false, writable: true })
const marker = process.env['FAKE_WORKER_MARKER']
let sequence = 0
let threads = 0
let ready = false
let current = null
let pending = null

if (marker) writeFileSync(join(marker, 'spawns.txt'), `${process.pid}\n`, { flag: 'a' })

const send = packet => output.write(`${JSON.stringify({ ...packet, worker_seq: sequence++ })}\n`)
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const event = value => send({ jsonrpc: '2.0', method: 'turn.event', params: { thread_id: current.thread, turn_id: current.turn, event: value } })

function finish(value) {
  event(value)
  current = null
  pending = null
}

function runTurn(thread, turn, message) {
  current = { thread, turn }
  if (message === 'approval') {
    pending = {
      approval_id: 'approval-1', thread_id: thread, turn_id: turn,
      operation_digest: 'a'.repeat(64), expires_at: new Date(Date.now() + 120_000).toISOString(),
      state: 'pending', cwd: process.cwd(), reason: 'Remote consequential action requires ALLOW_ONCE or DENY',
      command: 'node fixture.js',
    }
    return
  }
  if (message === 'cancel') {
    current.cancel = true
    return
  }
  event({ type: 'answer_chunk', text: 'fixture answer' })
  event({ type: 'tool_start', toolCallId: 'tool-1', tool: 'run_command', target: 'node fixture.js' })
  event({ type: 'tool_complete', toolCallId: 'tool-1', tool: 'run_command', target: 'node fixture.js', detail: 'ok', exitCode: 0 })
  finish({ type: 'done', answer: `fixture answer for ${thread}`, outcome: 'NO_CHANGE_REQUIRED', status: 'complete', usage: { totalTokens: 1 } })
}

let buffer = ''
input.setEncoding('utf8')
input.on('data', chunk => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line) continue
    const request = JSON.parse(line)
    const { id, method, params } = request
    if (method === 'worker.initialize') {
      if (process.env['OPENROUTER_API_KEY']) { fail(id, 'Worker must start without provider credentials'); continue }
      ready = true
      respond(id, { protocol_version: 1, engine_generation: params.authority.engine_generation, mode: 'chat' })
    } else if (!ready) {
      fail(id, 'Initialize the worker first')
    } else if (method === 'worker.credentials') {
      respond(id, { bound: true })
    } else if (method === 'thread.create') {
      threads += 1
      if (marker) writeFileSync(join(marker, 'threads.txt'), `${threads}\n`, { flag: 'a' })
      respond(id, { thread_id: `chat-fixture-${threads}` })
    } else if (method === 'thread.resume') {
      respond(id, { thread_id: params.thread_id })
    } else if (method === 'turn.submit') {
      if (current) { fail(id, 'A worker turn is already active'); continue }
      const turn = Number(params.command_id.replace(/\D/g, '')) || 1
      respond(id, { thread_id: params.thread_id, turn_id: turn })
      runTurn(params.thread_id, turn, params.message)
    } else if (method === 'approval.lookup') {
      respond(id, { pending: pending && pending.thread_id === params.thread_id ? [pending] : [] })
    } else if (method === 'approval.decide') {
      if (!pending) { fail(id, 'approval missing'); continue }
      if (params.turn_id !== String(pending.turn_id) || params.approval_id !== pending.approval_id) { fail(id, 'approval mismatch'); continue }
      const decision = params.decision
      pending = null
      respond(id, { approval_id: 'approval-1', decision, consumed: decision === 'allow_once' })
      finish(decision === 'allow_once'
        ? { type: 'done', answer: 'approved action completed', outcome: 'NO_CHANGE_REQUIRED', status: 'complete' }
        : { type: 'failed', error: 'The action was denied.' })
    } else if (method === 'turn.cancel') {
      respond(id, { cancelled: true })
      if (current?.cancel) finish({ type: 'cancelled' })
    } else if (method === 'worker.shutdown') {
      respond(id, { shutting_down: true })
      setTimeout(() => process.exit(0), 10)
    } else {
      fail(id, 'Unknown method')
    }
  }
})
