// Protocol fixture for private-worker-turn-lifecycle.test.mjs.
//
// W11 owns this fixture so the coalesced second-turn regression can be
// exercised without editing the shared worker fixture. It speaks the
// JSON-RPC worker surface over descriptors 3/4 and never calls a provider.
//
// Modes (environment):
//   W11_TURN2_COALESCE_STALE=1  turn 2 writes a stale turn-1 terminal event,
//                               the turn-2 admission response, and turn-2
//                               completion in one frame.
//   W11_ADMISSION_DELAY=1       turn admission is delayed 250ms so a caller can
//                               cancel before the turn id exists.
import { Socket } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const input = new Socket({ fd: 3, readable: true, writable: false })
const output = new Socket({ fd: 4, readable: false, writable: true })
const marker = process.env['W11_WORKER_MARKER']
let sequence = 0
let threads = 0
let ready = false
let current = null

if (marker) writeFileSync(join(marker, 'spawns.txt'), `${process.pid}\n`, { flag: 'a' })
if (marker) process.on('exit', () => writeFileSync(join(marker, 'exits.txt'), `${process.pid}\n`, { flag: 'a' }))

const send = packet => output.write(`${JSON.stringify({ ...packet, worker_seq: sequence++ })}\n`)
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const event = (thread, turn, value) => send({ jsonrpc: '2.0', method: 'turn.event', params: { thread_id: thread, turn_id: turn, event: value } })
const finish = (thread, turn, value) => {
  event(thread, turn, value)
  current = null
}

function runTurn(thread, turn, id, message) {
  current = { thread, turn, id }
  if (message === 'cancel-during-admission' && process.env['W11_ADMISSION_DELAY'] === '1') {
    // Admit only after the caller has had time to request cancellation.
    setTimeout(() => {
      if (!current || current.turn !== turn) return
      respond(id, { thread_id: thread, turn_id: turn })
    }, 250)
    return
  }
  respond(id, { thread_id: thread, turn_id: turn })
  event(thread, turn, { type: 'answer_chunk', text: `answer for ${message}` })
  finish(thread, turn, { type: 'done', answer: `answer for ${message}`, outcome: 'NO_CHANGE_REQUIRED', status: 'complete', usage: { totalTokens: 1 } })
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
      ready = true
      respond(id, { protocol_version: 1, engine_generation: params.authority.engine_generation, mode: 'chat' })
    } else if (!ready) {
      fail(id, 'Initialize the worker first')
    } else if (method === 'worker.credentials') {
      respond(id, { bound: true })
    } else if (method === 'thread.create') {
      threads += 1
      respond(id, { thread_id: `lifecycle-thread-${threads}` })
    } else if (method === 'thread.resume') {
      respond(id, { thread_id: params.thread_id })
    } else if (method === 'turn.submit') {
      if (current) { fail(id, 'A worker turn is already active'); continue }
      const turn = Number(String(params.command_id).replace(/\D/g, '')) || 1
      const thread = params.thread_id
      if (process.env['W11_TURN2_COALESCE_STALE'] === '1' && turn > 1) {
        // The stale terminal for the previous turn arrives before this turn's
        // admission response, in the same read, like the audit reproduction.
        const frame = value => ({ jsonrpc: '2.0', method: 'turn.event',
          params: { thread_id: thread, turn_id: value.turn, event: value.event } })
        const packets = [
          frame({ turn: turn - 1, event: { type: 'done', answer: 'stale prior turn', outcome: 'NO_CHANGE_REQUIRED', status: 'complete' } }),
          { jsonrpc: '2.0', id, result: { thread_id: thread, turn_id: turn } },
          frame({ turn, event: { type: 'answer_chunk', text: 'second answer' } }),
          frame({ turn, event: { type: 'done', answer: 'second answer', outcome: 'NO_CHANGE_REQUIRED', status: 'complete', usage: { totalTokens: 1 } } }),
        ]
        output.write(`${packets.map(packet => JSON.stringify({ ...packet, worker_seq: sequence++ })).join('\n')}\n`)
        current = null
        continue
      }
      current = { thread, turn, id }
      runTurn(thread, turn, id, String(params.message))
    } else if (method === 'turn.cancel') {
      const active = current
      respond(id, { cancelled: true })
      if (active) { current = null; event(active.thread, active.turn, { type: 'cancelled' }) }
    } else if (method === 'approval.lookup') {
      respond(id, { pending: [] })
    } else if (method === 'worker.shutdown') {
      respond(id, { shutting_down: true })
      setTimeout(() => process.exit(0), 10)
    } else {
      fail(id, 'Unknown method')
    }
  }
})
