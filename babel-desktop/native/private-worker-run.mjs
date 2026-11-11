import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { scopedApproval, scopedApprovalReply } from '../src/core.mjs'
import { productionNodeCliArgv } from './cli-launch.mjs'

/** Worker credential names. They must never be inherited by the worker process. */
export const WORKER_CREDENTIAL_NAMES = Object.freeze([
  'OPENROUTER_API_KEY', 'DEEPINFRA_API_KEY', 'DEEPSEEK_API_KEY', 'COMMAND_CODE_API_KEY',
  'BABEL_OPENCODE_GO_API_KEY', 'BABEL_COMPACTION_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENCODE_API_KEY',
  'BABEL_COMPATIBLE_API_KEY', 'DEEPINFRA_TOKEN',
])

/** Provider -> the single credential name the worker may receive. */
export const WORKER_PROVIDER_KEYS = Object.freeze({
  ollama: null,
  openrouter: 'OPENROUTER_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'command-code': 'COMMAND_CODE_API_KEY',
  'opencode-go': 'BABEL_OPENCODE_GO_API_KEY',
})

const MAX_FRAME = 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const APPROVAL_POLL_MS = 400
const TERMINALS = new Set(['done', 'failed', 'cancelled'])

function isSafeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) }

/** A credential-bearing environment is rebuilt from scratch for the worker. */
export function buildWorkerEnvironment(env, {provider, projectRoot, model}) {
  const next = { ...env }
  const value = WORKER_PROVIDER_KEYS[provider] ? next[WORKER_PROVIDER_KEYS[provider]] : undefined
  for (const name of WORKER_CREDENTIAL_NAMES) delete next[name]
  delete next['BABEL_ALLOW_HOST_FALLBACK']
  delete next['BABEL_PROJECT_CREDENTIALS_DIR']
  delete next['BABEL_LEGACY_CLI_ENV']
  delete next['BABEL_APPROVAL_SESSION']
  next['BABEL_EXECUTION_PROFILE'] = 'host_native'
  next['BABEL_DESKTOP_PROVIDER'] = provider
  next['BABEL_PROJECT_ROOT'] = projectRoot
  next['BABEL_REMOTE_OPERATOR_APPROVAL'] = '1'
  next['BABEL_DAEMON_ENABLED'] = 'false'
  // The worker authenticates the exact model route the engine must select.
  next['BABEL_DESKTOP_MODEL_ROUTE'] = model
  next['BABEL_MODEL'] = model
  return { env: next, credential: typeof value === 'string' && value ? { [WORKER_PROVIDER_KEYS[provider]]: value } : {} }
}

/** Project one worker ChatEvent onto the stream-json shape the renderer consumes. */
export function workerEventToDesktop(event, {threadId, unverified = false} = {}) {
  if (!event || typeof event !== 'object') return null
  switch (event.type) {
    case 'answer_chunk': return { type: 'assistant_chunk', chunk: String(event.text ?? '') }
    case 'thought': return { type: 'thought', line: String(event.text ?? '') }
    case 'thinking': return { type: 'progress', message: 'Thinking' }
    case 'tool_start': return { type: 'tool.started', item: { id: String(event.toolCallId ?? ''), tool: String(event.tool ?? 'tool'), target: String(event.target ?? '') } }
    case 'tool_complete':
    case 'tool_failed': return {
      type: event.type === 'tool_complete' ? 'tool.completed' : 'tool.failed',
      item: {
        id: String(event.toolCallId ?? ''), tool: String(event.tool ?? 'tool'), target: String(event.target ?? ''),
        detail: String(event.detail ?? event.error ?? '').slice(0, 4_000),
        ...(Number.isInteger(event.exitCode) ? { exit_code: event.exitCode } : {}),
      },
    }
    case 'file_changed': return { type: 'file.changed', item: { path: String(event.path ?? 'file'), additions: Number(event.additions) || 0, deletions: Number(event.deletions) || 0 } }
    case 'done': return {
      type: 'run_complete',
      result: {
        ...(typeof event.outcome === 'string' ? { terminal_outcome: event.outcome } : {}),
        ...(typeof event.status === 'string' ? { user_status: event.status } : {}),
        answer: { answer: String(event.answer ?? '') },
        ...(event.usage ? { usage: event.usage } : {}),
        ...(threadId ? { session_id: threadId } : {}),
        ...(typeof event.runDir === 'string' ? { run_dir: event.runDir } : {}),
        ...(unverified ? { verification: { status: 'unverified' } } : {}),
      },
    }
    case 'failed': return { type: 'run_error', error: String(event.error ?? 'Babel reported a failure.') }
    case 'cancelled': return { type: 'cancelled', status: 'CANCELLED' }
    default: return null
  }
}

/** Bind a polled worker approval to the Desktop run identity the renderer checks. */
export function approvalToDesktop(record, runId) {
  if (!record || typeof record !== 'object') return null
  const approval = scopedApproval({
    schemaVersion: 2,
    request_id: `worker:${String(record.approval_id ?? '')}`,
    thread_id: record.thread_id,
    turn_id: String(record.turn_id ?? ''),
    operation_digest: record.operation_digest,
    run_id: runId,
    expires_at: record.expires_at,
  })
  if (!approval) return null
  return {
    approval,
    event: {
      type: 'approval.required',
      message: 'Babel is waiting for approval before a consequential action.',
      item: {
        ...(typeof record.command === 'string' ? { command: record.command } : {}),
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        ...(typeof record.reason === 'string' ? { details: record.reason } : {}),
        approval,
      },
    },
  }
}

/**
 * Desktop-owned resident protocol worker. It keeps one authenticated worker
 * (and therefore one ChatEngine per thread) alive across sequential turns
 * while the project, provider, model, and engine generation stay fixed.
 */
export class PrivateWorkerRun {
  #child = null
  #input = null
  #output = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #stderr = ''
  #started = false
  #busy = false
  #closing = false
  #runId = null
  #threadId = null
  #turnId = null
  #onPacket = null
  #idleCallbacks = []
  #approvals = new Map()
  #pendingApproval = null
  #approvalTimer = null
  #unverified = false
  #exited = false
  #reportedExit = false

  constructor({ executable, entry, projectRoot, provider, providerModelId, model, configurationGeneration = 'desktop', engineGeneration = 'desktop', env = {}, inheritEnv = true }) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute')
    if (!isAbsolute(entry)) throw new TypeError('The worker entry must be absolute')
    if (!isAbsolute(projectRoot)) throw new TypeError('The project root must be absolute')
    if (!Object.hasOwn(WORKER_PROVIDER_KEYS, provider)) throw new TypeError('Unsupported worker provider')
    this.executable = executable
    this.entry = entry
    this.projectRoot = projectRoot
    this.provider = provider
    this.providerModelId = providerModelId
    this.model = model
    this.configurationGeneration = configurationGeneration
    this.engineGeneration = engineGeneration
    this.env = env
    this.inheritEnv = inheritEnv
  }

  get busy() { return this.#busy }
  get awaitingApproval() { return Boolean(this.#pendingApproval && Date.parse(this.#pendingApproval.expires_at) > Date.now()) }
  get alive() { return Boolean(this.#child && !this.#exited) }

  #send(packet) {
    if (!this.#input || this.#input.destroyed) throw new Error('The Babel worker is not running')
    this.#input.write(`${JSON.stringify(packet)}\n`)
  }

  #request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Babel worker did not answer ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try { this.#send({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error) }
    })
  }

  #settle(id, packet) {
    const waiter = this.#pending.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.#pending.delete(id)
    if (packet.error) waiter.reject(new Error(String(packet.error.message ?? 'Worker request failed')))
    else waiter.resolve(packet.result)
  }

  #notification(packet) {
    if (packet.method === 'turn.event') {
      const params = packet.params ?? {}
      if (params.thread_id !== this.#threadId) return
      this.#onEvent(params.event)
      return
    }
    if (packet.method === 'worker.preview_truncated') {
      this.#emit({ kind: 'transport-error', error: 'The worker preview exceeded its display limit. Control events remain available; completion will remain unverified.' })
      this.#unverified = true
      return
    }
    if (packet.method === 'worker.durability' && packet.params?.status === 'unverified') this.#unverified = true
  }

  #onData(chunk) {
    this.#buffer += chunk
    let end
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      if (!line) continue
      let packet
      try { packet = JSON.parse(line) } catch { continue }
      if (packet && Object.hasOwn(packet, 'id') && (packet.result !== undefined || packet.error !== undefined)) this.#settle(packet.id, packet)
      else if (packet?.method) this.#notification(packet)
    }
    if (this.#buffer.length > MAX_FRAME) this.#fail('The Babel worker emitted an oversized frame.')
  }

  #emit(packet) {
    if (typeof this.#onPacket === 'function') this.#onPacket({ runId: this.#runId, ...packet })
  }

  #onEvent(event) {
    if (!event || typeof event !== 'object') return
    const desktop = workerEventToDesktop(event, { threadId: this.#threadId, unverified: this.#unverified })
    if (!desktop) return
    this.#emit({ kind: 'event', event: desktop })
    if (TERMINALS.has(event.type)) this.#finish(event.type === 'cancelled' ? { code: 0 } : { code: event.type === 'failed' ? 1 : 0 })
  }

  #finish({ code }) {
    if (!this.#busy) return
    this.#busy = false
    this.#stopApprovalPolling()
    clearTimeout(this.#terminalGuard)
    this.#pendingApproval = null
    this.#approvals.clear()
    this.#emit({ kind: 'exit', code, signal: null, diagnosticAvailable: this.#stderr.length > 0, displayLimited: false })
    this.#runId = null
    this.#onPacket = null
    const callbacks = this.#idleCallbacks.splice(0)
    for (const callback of callbacks) { try { callback() } catch { /* idle observer */ } }
  }

  #fail(message) {
    if (!this.#busy) return
    this.#emit({ kind: 'event', event: { type: 'run_error', error: message } })
    this.#finish({ code: 1 })
  }

  async #ensureStarted() {
    if (this.#started && this.#child && !this.#exited) return
    const { env, credential } = buildWorkerEnvironment(
      this.inheritEnv ? { ...process.env, ...this.env } : { ...this.env },
      { provider: this.provider, projectRoot: this.projectRoot, model: this.model },
    )
    const child = spawn(this.executable, productionNodeCliArgv(this.entry, []), {
      cwd: this.projectRoot, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env,
    })
    this.#child = child
    this.#exited = false
    this.#reportedExit = false
    child.stdout?.resume()
    child.stderr?.resume()
    child.stderr?.on('data', chunk => {
      if (this.#stderr.length >= 32_768) return
      this.#stderr += String(chunk).slice(0, 32_768 - this.#stderr.length)
    })
    const input = child.stdio[3]
    const output = child.stdio[4]
    if (!input || !output) throw new Error('The Babel worker did not expose its private pipes')
    this.#input = input
    this.#output = output
    output.setEncoding('utf8')
    output.on('data', chunk => this.#onData(chunk))
    output.on('error', () => this.#fail('The Babel worker connection failed.'))
    child.on('error', error => this.#fail(`Could not start the Babel runtime: ${error.message}`))
    child.on('close', (code, signal) => {
      this.#exited = true
      this.#started = false
      for (const [id, waiter] of this.#pending) { clearTimeout(waiter.timer); waiter.reject(new Error('The Babel worker exited')); this.#pending.delete(id) }
      if (this.#busy) {
        this.#emit({ kind: 'event', event: { type: 'run_error', error: 'The Babel runtime exited before the turn settled.' } })
        this.#finish({ code: code ?? 1, signal })
      } else if (!this.#reportedExit && !this.#closing) {
        this.#reportedExit = true
        this.#emit({ kind: 'exit', code: code ?? 1, signal: signal ?? null, diagnosticAvailable: this.#stderr.length > 0, displayLimited: false })
      }
    })
    const authority = {
      project_root: this.projectRoot,
      mode: 'chat',
      execution_profile: 'host_native',
      approval_policy: 'allow_once',
      provider: this.provider,
      model: this.model,
      provider_model_id: this.providerModelId,
      credential_ref: `${this.provider}:${this.model}`,
      configuration_generation: this.configurationGeneration,
      engine_generation: this.engineGeneration,
    }
    await this.#request('worker.initialize', { protocol_version: 1, authority })
    await this.#request('worker.credentials', { values: credential })
    this.#started = true
  }

  async #ensureThread(request) {
    if (typeof request.sessionId === 'string' && request.sessionId) {
      if (request.sessionId !== this.#threadId) {
        await this.#request('thread.resume', { thread_id: request.sessionId })
        this.#threadId = request.sessionId
      }
      return this.#threadId
    }
    // No session id means a new conversation; never silently append a fresh
    // Desktop conversation to the previous thread.
    const created = await this.#request('thread.create', { task: String(request.task ?? '') })
    if (!created || typeof created.thread_id !== 'string') throw new Error('The Babel worker did not create a thread')
    this.#threadId = created.thread_id
    return this.#threadId
  }

  async start(request, onPacket) {
    if (this.#busy) throw new Error('A Babel worker turn is already running')
    if (!request || typeof request.runId !== 'string' || !isSafeId(request.runId)) throw new TypeError('Invalid run ID')
    if (typeof request.task !== 'string' || !request.task.trim()) throw new TypeError('Invalid task text')
    this.#busy = true
    this.#runId = request.runId
    this.#onPacket = onPacket
    this.#unverified = false
    this.#pendingApproval = null
    try {
      await this.#ensureStarted()
      const threadId = await this.#ensureThread(request)
      const submitted = await this.#request('turn.submit', {
        thread_id: threadId, message: request.task, command_id: request.runId,
        ...(request.executionScope?.kind === 'project' ? { repo_identity_confirmed: true } : {}),
      })
      if (!submitted || !Number.isSafeInteger(submitted.turn_id)) throw new Error('The Babel worker did not admit the turn')
      this.#turnId = submitted.turn_id
      this.#startApprovalPolling()
      this.#terminalGuard = setTimeout(() => {
        this.#fail(this.#unverified ? 'The turn ended without verified terminal evidence.' : 'The Babel worker did not report a terminal outcome.')
      }, 30 * 60_000)
      this.#terminalGuard.unref?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The Babel worker could not start this turn.'
      this.#emit({ kind: 'event', event: { type: 'run_error', error: message } })
      this.#finish({ code: 1 })
    }
  }

  #terminalGuard = null

  #startApprovalPolling() {
    this.#stopApprovalPolling()
    const poll = async () => {
      if (!this.#busy || !this.#threadId) return
      try {
        const result = await this.#request('approval.lookup', { thread_id: this.#threadId })
        for (const record of result?.pending ?? []) {
          if (this.#approvals.has(record.approval_id)) continue
          const mapped = approvalToDesktop(record, this.#runId)
          if (!mapped) continue
          this.#approvals.set(record.approval_id, record)
          this.#pendingApproval = mapped.approval
          this.#emit({ kind: 'event', event: mapped.event })
        }
      } catch { /* polling is advisory; the terminal event carries the outcome */ }
    }
    this.#approvalTimer = setInterval(() => { void poll() }, APPROVAL_POLL_MS)
    this.#approvalTimer.unref?.()
    void poll()
  }

  #stopApprovalPolling() {
    if (this.#approvalTimer) clearInterval(this.#approvalTimer)
    this.#approvalTimer = null
  }

  reply(request) {
    if (!this.#busy || !this.#threadId || !this.#turnId) return false
    if (request?.runId !== this.#runId) return false
    const reply = scopedApprovalReply(request, this.#pendingApproval)
    if (!reply) return false
    const approvalId = String(reply.approval.request_id).replace(/^worker:/, '')
    const record = this.#approvals.get(approvalId)
    if (!record) return false
    this.#pendingApproval = null
    void this.#request('approval.decide', {
      thread_id: this.#threadId, turn_id: String(record.turn_id), approval_id: approvalId,
      decision: reply.decision, ...(record.operation_digest ? { operation_digest: record.operation_digest } : {}),
    }).catch(() => undefined)
    return true
  }

  whenIdle(callback) {
    if (typeof callback !== 'function') return
    if (!this.#busy) { callback(); return }
    this.#idleCallbacks.push(callback)
  }

  cancel() {
    this.#pendingApproval = null
    if (!this.#busy || !this.#threadId || !this.#turnId) return
    void this.#request('turn.cancel', { thread_id: this.#threadId }, 15_000)
      .catch(() => this.#fail('The Babel worker did not acknowledge cancellation.'))
  }

  /** End the resident worker and wait for its owned process to exit. */
  async shutdown({ timeoutMs = 8_000 } = {}) {
    if (!this.#child || this.#exited) return { forced: false }
    this.#closing = true
    this.#busy = false
    this.#stopApprovalPolling()
    const child = this.#child
    const exited = new Promise(resolve => {
      if (child.exitCode !== null) { resolve({ forced: false }); return }
      child.once('close', () => resolve({ forced }))
    })
    try { this.#send({ jsonrpc: '2.0', id: this.#nextId++, method: 'worker.shutdown', params: {} }) } catch { /* already gone */ }
    const timer = setTimeout(() => { forced = true; try { child.kill() } catch { /* exited */ } }, timeoutMs)
    let forced = false
    const result = await exited
    clearTimeout(timer)
    return { forced: result.forced || forced }
  }
}
