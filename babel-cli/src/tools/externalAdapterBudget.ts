/**
 * Shared output/settlement budget for external tool adapters.
 *
 * Web, plugin, audit and MCP adapters all consume untrusted external content.
 * They must not differ in how much of that content they retain, or in whether a
 * spawned helper is actually settled before the tool result is reported.
 */

import { spawn, type ChildProcess } from 'node:child_process'

import { terminateChildTree } from '../processTree.js'

/** Default retained bytes for one external tool result. */
export const DEFAULT_EXTERNAL_TOOL_MAX_OUTPUT_BYTES = 200_000

/** Default wall-clock ceiling for one helper process. */
export const DEFAULT_EXTERNAL_TOOL_TIMEOUT_MS = 15_000

/** Grace period allowed for a killed helper tree to report `close`. */
const SETTLEMENT_GRACE_MS = 1_000

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolve the retained-output byte ceiling for external adapters. */
export function resolveExternalToolMaxOutputBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.max(
    1,
    positiveInteger(env['BABEL_EXTERNAL_TOOL_MAX_BYTES'], DEFAULT_EXTERNAL_TOOL_MAX_OUTPUT_BYTES),
  )
}

/** Resolve the helper-process timeout for external adapters. */
export function resolveExternalToolTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env['BABEL_EXTERNAL_TOOL_TIMEOUT_MS'], DEFAULT_EXTERNAL_TOOL_TIMEOUT_MS)
}

export interface BoundedText {
  text: string
  truncated: boolean
  bytes: number
  retained_bytes: number
}

/** Bound one UTF-8 string without splitting a multi-byte code point. */
export function boundExternalText(text: string, maxBytes: number): BoundedText {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) {
    return { text, truncated: false, bytes, retained_bytes: bytes }
  }
  const buffer = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes))
  // Trim a trailing partial UTF-8 sequence.
  let end = buffer.length
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1
  if (end > 0 && (buffer[end - 1]! & 0x80) !== 0) end -= 1
  const retained = buffer.subarray(0, end).toString('utf8')
  return {
    text: retained,
    truncated: true,
    bytes,
    retained_bytes: Buffer.byteLength(retained, 'utf8'),
  }
}

export interface BoundedExternalProcessInput {
  command: string
  args?: readonly string[]
  cwd?: string
  timeoutMs?: number
  maxBytes?: number
  env?: NodeJS.ProcessEnv
}

export interface BoundedExternalProcessResult {
  exit_code: number
  signal: NodeJS.Signals | null
  timed_out: boolean
  stdout: string
  stderr: string
  stdout_truncated: boolean
  stderr_truncated: boolean
  duration_ms: number
  settled: boolean
}

/**
 * Run a helper process with one bounded result and guaranteed settlement.
 *
 * The child is placed in its own process group on POSIX so a timeout or output
 * overflow can settle descendants, not only the direct child. The promise
 * resolves exactly once; late `close`/`error` events cannot change the result.
 */
export function runBoundedExternalProcess(
  input: BoundedExternalProcessInput,
): Promise<BoundedExternalProcessResult> {
  const maxBytes = input.maxBytes ?? resolveExternalToolMaxOutputBytes(input.env ?? process.env)
  const timeoutMs = input.timeoutMs ?? resolveExternalToolTimeoutMs(input.env ?? process.env)
  const startedAt = Date.now()

  return new Promise<BoundedExternalProcessResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(input.command, [...(input.args ?? [])], {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        ...(input.env ? { env: input.env } : {}),
      })
    } catch {
      resolve({
        exit_code: 1,
        signal: null,
        timed_out: false,
        stdout: '',
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: Date.now() - startedAt,
        settled: true,
      })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutRetained = 0
    let stderrRetained = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (exitCode: number, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolve({
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Date.now() - startedAt,
        settled: true,
      })
    }

    const retain = (
      chunks: Buffer[],
      chunk: Buffer,
      retained: number,
    ): { retained: number; truncated: boolean } => {
      if (retained >= maxBytes) return { retained, truncated: true }
      const slice = chunk.subarray(0, maxBytes - retained)
      chunks.push(slice)
      return {
        retained: retained + slice.length,
        truncated: slice.length < chunk.length,
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = retain(stdoutChunks, chunk, stdoutRetained)
      stdoutRetained = next.retained
      if (next.truncated) stdoutTruncated = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = retain(stderrChunks, chunk, stderrRetained)
      stderrRetained = next.retained
      if (next.truncated) stderrTruncated = true
    })

    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminateChildTree(child)
      killTimer = setTimeout(() => {
        // The helper did not close after the tree kill; report the bounded
        // timeout instead of waiting forever.
        if (settled) return
        terminateChildTree(child)
        settle(1, 'SIGKILL')
      }, SETTLEMENT_GRACE_MS)
    }, timeoutMs)

    child.on('error', () => settle(1, null))
    child.on('close', (code, signal) => settle(code ?? 1, signal))
  })
}
