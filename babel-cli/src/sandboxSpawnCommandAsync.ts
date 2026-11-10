import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'

import type { ProcessWitness, ProcessWitnessInput } from './diagnostics/bdns/processWitness.js'
import { MAX_SHELL_OUTPUT_BYTES } from './shellOutputNormalize.js'
import {
  terminateChildTree as terminateChildTreeShared,
  waitForProcessGroupExit,
} from './processTree.js'
import { registerPendingProcessTermination } from './sandboxProcessTermination.js'

export interface AsyncSpawnResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  stdoutTruncated: boolean
  stderrTruncated: boolean
  aborted: boolean
  /** Process reached the spawn callback before the error (runtime, not launch). */
  processStarted: boolean
  /** Wall-clock supervisor timeout after a successful launch. */
  timedOut: boolean
  /** Particular aborted client closure; daemon cleanup must follow this barrier. */
  termination?: Promise<void>
}

function appendCappedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
): { bytes: number; truncated: boolean } {
  const remaining = MAX_SHELL_OUTPUT_BYTES - currentBytes
  if (remaining <= 0) return { bytes: currentBytes, truncated: chunk.length > 0 }
  if (chunk.length <= remaining) {
    chunks.push(chunk)
    return { bytes: currentBytes + chunk.length, truncated: false }
  }
  chunks.push(chunk.subarray(0, remaining))
  return { bytes: MAX_SHELL_OUTPUT_BYTES, truncated: true }
}

/** Narrow host test hooks for spawnCommandAsync; not used in production Chat paths. */
export interface SpawnCommandAsyncTestContext {
  /** Synchronous signal that the close handler entered POSIX natural settlement. */
  onNaturalCloseSettlementEntered?: (pid: number) => void
  /** Awaited before the first owned process-group probe; holds settlement pending in tests. */
  awaitNaturalCloseSettlementGate?: () => void | Promise<void>
}

/**
 * W0.1 Process supervisor — async spawn with AbortSignal, output caps, tree kill.
 * Used by SafeExecutor.shellExecAsync (chat/REPL foreground path).
 */
export function spawnCommandAsync(
  executable: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    processWitness?: ProcessWitness
    processContext?: Pick<ProcessWitnessInput, 'sessionId' | 'turnId' | 'toolCallId' | 'toolName' | 'projectRoot'>
    testContext?: SpawnCommandAsyncTestContext
  },
): Promise<AsyncSpawnResult> {
  const processInput: ProcessWitnessInput = {
    executable,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.processContext ?? {}),
  }
  const executionId = options.processWitness?.requested(processInput)
  if (options.signal?.aborted) {
    if (executionId) options.processWitness?.cancelRequested(processInput, executionId)
    return Promise.resolve({
      status: 1,
      stdout: '',
      stderr: '',
      error: new Error(`spawn ${executable} aborted`),
      stdoutTruncated: false,
      stderrTruncated: false,
      aborted: true,
      processStarted: false,
      timedOut: false,
    })
  }

  return new Promise((resolveResult) => {
    let child: ChildProcessWithoutNullStreams
    let processStarted = false
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        ...(process.platform === 'win32' && basename(executable).toLowerCase() === 'cmd.exe'
          ? { windowsVerbatimArguments: true }
          : {}),
        // POSIX: new process group so terminateChildTree can SIGTERM -pid.
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      if (executionId) options.processWitness?.failedToStart(processInput, executionId, err)
      resolveResult({
        status: 1,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err : new Error(String(err)),
        stdoutTruncated: false,
        stderrTruncated: false,
        aborted: false,
        processStarted: false,
        timedOut: false,
      })
      return
    }

    child.once('spawn', () => {
      processStarted = true
      if (executionId) options.processWitness?.started(processInput, executionId, child.pid)
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    let witnessTerminalRecorded = false
    let timeout: NodeJS.Timeout | null = null
    let abortSettle: NodeJS.Timeout | null = null
    let termination: Promise<void> | undefined
    let physicalChildClosed = false
    let releaseAbortPhysicalClose: (() => void) | undefined
    const abortPhysicalClose = new Promise<void>((resolveAbortPhysicalClose) => {
      releaseAbortPhysicalClose = resolveAbortPhysicalClose
    })
    let releasePhysicalClose: (() => void) | undefined
    const physicalClose = new Promise<void>((resolvePhysicalClose) => {
      releasePhysicalClose = resolvePhysicalClose
    })

    const terminateChildTree = (owned: ChildProcessWithoutNullStreams) => terminateChildTreeShared(owned)

    const recordWitnessTerminal = (status: number | null, error?: Error) => {
      if (witnessTerminalRecorded || !executionId) return
      witnessTerminalRecorded = true
      if (executionId) {
        if (!processStarted && error) options.processWitness?.failedToStart(processInput, executionId, error)
        else options.processWitness?.exited(processInput, executionId, {
          exitCode: status,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          ...(error ? { error: error.message } : {}),
        })
      }
    }

    const finish = (status: number | null, error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (abortSettle) clearTimeout(abortSettle)
      options.signal?.removeEventListener('abort', onAbort)
      resolveResult({
        status,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        ...(error ? { error } : {}),
        stdoutTruncated,
        stderrTruncated,
        aborted,
        processStarted,
        timedOut,
        ...(termination ? { termination } : {}),
      })
    }

    const onAbort = () => {
      aborted = true
      if (executionId) options.processWitness?.cancelRequested(processInput, executionId)
      // A close that already chose the natural-settlement path can still be
      // settling when cancel arrives. Reuse that deferred tree work and release
      // the abort latch when the direct child has physically closed.
      if (physicalChildClosed) releaseAbortPhysicalClose?.()
      if (termination) {
        if (!settled) finish(1, new Error(`spawn ${executable} aborted`))
        return
      }
      // Unblock the tool awaiter first (cancel p95). Defer tree-kill to the next
      // event-loop turn so spawnSync(taskkill) cannot hold the promise microtask
      // queue — otherwise Windows cancel latency is dominated by taskkill, not
      // by AbortSignal delivery.
      termination = new Promise<void>((resolveTermination, rejectTermination) => {
        let complete = false
        const closeTimeout = setTimeout(() => {
          if (complete) return
          complete = true
          rejectTermination(new Error(`Aborted process ${executable} did not close after tree termination`))
        }, 5_000)
        setImmediate(() => {
          void (async () => {
            try {
              const pid = child.pid
              if (!pid) {
                throw new Error(`Aborted spawn missing child pid for ${executable}`)
              }
              const terminationAttempt = terminateChildTree(child)
              if (process.platform === 'win32' && !terminationAttempt.treeKillAccepted) {
                throw new Error('Windows process-tree termination was not confirmed by taskkill')
              }
              const groupExited = await waitForProcessGroupExit(pid, 5_000)
              if (!groupExited) {
                throw new Error(`Aborted process group ${pid} did not exit after tree termination`)
              }
              await abortPhysicalClose
              if (complete) return
              complete = true
              clearTimeout(closeTimeout)
              resolveTermination()
            } catch (error) {
              if (complete) return
              complete = true
              clearTimeout(closeTimeout)
              rejectTermination(error)
            }
          })()
        })
      })
      registerPendingProcessTermination(
        termination,
        options.processContext?.sessionId ?? 'unscoped',
        executionId ?? `${executable}:${child.pid ?? 'unknown'}`,
      )
      finish(1, new Error(`spawn ${executable} aborted`))
    }

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        if (executionId) options.processWitness?.timeout(processInput, executionId)
        // The parent's `close` event says nothing about its descendants. A
        // supervisor deadline must not settle until the owned process group is
        // physically gone, or callers observe a "timed out" tool while an
        // orphaned test/child process still runs.
        termination = new Promise<void>((resolveTermination, rejectTermination) => {
          let complete = false
          const closeTimeout = setTimeout(() => {
            if (complete) return
            complete = true
            rejectTermination(new Error(`Timed-out process ${executable} did not close after tree termination`))
          }, 5_000)
          setImmediate(() => {
            void (async () => {
              try {
                const pid = child.pid
                const terminationAttempt = terminateChildTree(child)
                if (process.platform === 'win32' && pid && !terminationAttempt.treeKillAccepted) {
                  throw new Error('Windows process-tree termination was not confirmed by taskkill')
                }
                // No pid means there is no owned process group to observe, but
                // the direct child may still emit its physical close.
                if (pid) {
                  const groupExited = await waitForProcessGroupExit(pid, 5_000)
                  if (!groupExited) {
                    throw new Error(`Timed-out process group ${pid} did not exit after tree termination`)
                  }
                }
                await physicalClose
                if (complete) return
                complete = true
                clearTimeout(closeTimeout)
                resolveTermination()
              } catch (error) {
                if (complete) return
                complete = true
                clearTimeout(closeTimeout)
                rejectTermination(error)
              }
            })()
          })
        })
        // The close handler attaches the observable rejection; this prevents an
        // unhandled rejection if the process hangs and close never arrives.
        void termination.catch(() => {})
        registerPendingProcessTermination(
          termination,
          options.processContext?.sessionId ?? 'unscoped',
          executionId ?? `${executable}:${child.pid ?? 'unknown'}`,
        )
      }, options.timeoutMs)
      timeout.unref?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer | string) => {
      const update = appendCappedChunk(
        stdoutChunks,
        stdoutBytes,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      )
      stdoutBytes = update.bytes
      stdoutTruncated ||= update.truncated
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      const update = appendCappedChunk(
        stderrChunks,
        stderrBytes,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      )
      stderrBytes = update.bytes
      stderrTruncated ||= update.truncated
    })

    child.once('error', (err) => {
      if (!processStarted) recordWitnessTerminal(1, err)
      finish(1, err)
    })
    child.once('close', (code) => {
      physicalChildClosed = true
      releasePhysicalClose?.()
      if (aborted) {
        recordWitnessTerminal(code ?? 1, new Error(`spawn ${executable} aborted`))
        if (executionId) options.processWitness?.killed(processInput, executionId)
        releaseAbortPhysicalClose?.()
        finish(code ?? 1, new Error(`spawn ${executable} aborted`))
      } else if (timedOut) {
        const settleTimedOut = (error?: Error) => {
          recordWitnessTerminal(code ?? 1, error ?? new Error(`spawn ${executable} ETIMEDOUT`))
          finish(error ? 1 : code ?? 1, error ?? new Error(`spawn ${executable} ETIMEDOUT`))
        }
        if (termination) {
          void termination.then(
            () => settleTimedOut(),
            (error: unknown) => settleTimedOut(error instanceof Error ? error : new Error(String(error))),
          )
        } else {
          settleTimedOut()
        }
      } else if (process.platform !== 'win32' && child.pid) {
        const pid = child.pid
        options.testContext?.onNaturalCloseSettlementEntered?.(pid)
        let settlementError: Error | undefined
        termination = new Promise<void>((resolveTermination, rejectTermination) => {
          void (async () => {
            try {
              if (options.testContext?.awaitNaturalCloseSettlementGate) {
                await options.testContext.awaitNaturalCloseSettlementGate()
              }
              let descendantsSettled = await waitForProcessGroupExit(pid, 150)
              let hadLingeringDescendants = false
              if (!descendantsSettled) {
                hadLingeringDescendants = true
                terminateChildTree(child)
                descendantsSettled = await waitForProcessGroupExit(pid, 5_000)
              }
              if (!descendantsSettled) {
                rejectTermination(new Error(`spawn ${executable} process-tree termination could not be confirmed`))
                return
              }
              if (hadLingeringDescendants) {
                settlementError = new Error(`Owned descendants remained after ${executable} direct exit and were terminated`)
              }
              resolveTermination()
            } catch (error) {
              rejectTermination(error instanceof Error ? error : new Error(String(error)))
            }
          })()
        })
        void termination.catch(() => {})
        registerPendingProcessTermination(
          termination,
          options.processContext?.sessionId ?? 'unscoped',
          executionId ?? `${executable}:${child.pid ?? 'unknown'}`,
        )
        const recordNaturalCloseWitness = () => {
          if (aborted) {
            recordWitnessTerminal(code ?? 1, new Error(`spawn ${executable} aborted`))
            if (executionId) options.processWitness?.killed(processInput, executionId)
            return
          }
          if (settlementError) {
            recordWitnessTerminal(1, settlementError)
            return
          }
          recordWitnessTerminal(code)
        }
        void termination.then(
          () => {
            recordNaturalCloseWitness()
            if (settled) return
            if (aborted) {
              finish(code ?? 1, new Error(`spawn ${executable} aborted`))
              return
            }
            if (settlementError) {
              finish(1, settlementError)
              return
            }
            finish(code)
          },
          (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error))
            recordWitnessTerminal(1, err)
            if (settled) return
            finish(1, err)
          },
        )
      } else {
        recordWitnessTerminal(code)
        finish(code)
      }
    })
  })
}
