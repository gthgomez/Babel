import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

/** Caller-owned persistent reservation state; never contains request data or credentials. */
export interface OpenCodeGoBudgetOptions {
  statePath: string
  jobId: string
  limitUsd: number
}

/** Content-free, fail-closed budget error; callers must not select another provider. */
export class OpenCodeGoBudgetError extends Error {
  readonly code = 'GO_BUDGET_DENIED'
  constructor() { super('OpenCode Go budget denied the request.') }
}

/** Shared cross-process ledger. Reservations are durable before dispatch and never refunded. */
export class OpenCodeGoBudget {
  private readonly limitNanoUsd: number
  private readonly options: Readonly<OpenCodeGoBudgetOptions>
  constructor(options: OpenCodeGoBudgetOptions) {
    if (!isAbsolute(options.statePath) || !options.jobId.trim() ||
      !Number.isFinite(options.limitUsd) || options.limitUsd <= 0 || options.limitUsd > 2) {
      throw new OpenCodeGoBudgetError()
    }
    this.options = Object.freeze({ ...options })
    this.limitNanoUsd = Math.floor(options.limitUsd * 1e9)
  }

  /** Atomically reserve conservative peak cost from actual serialized request bytes. */
  async reserve(inputBytes: number, maxOutputTokens: number): Promise<void> {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new OpenCodeGoBudgetError()
    const amount = inputBytes * 300 + maxOutputTokens * 1200
    if (!Number.isSafeInteger(amount) || amount > this.limitNanoUsd) throw new OpenCodeGoBudgetError()
    const lockPath = `${this.options.statePath}.lock`
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch { throw new OpenCodeGoBudgetError() }
    const tempPath = `${this.options.statePath}.${randomUUID()}.tmp`
    try {
      let state = { schema: 1, jobId: this.options.jobId, limitNanoUsd: this.limitNanoUsd, reservedNanoUsd: 0, attempts: 0 }
      try {
        state = JSON.parse(await readFile(this.options.statePath, 'utf8')) as typeof state
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new OpenCodeGoBudgetError()
      }
      if (state.schema !== 1 || state.jobId !== this.options.jobId || state.limitNanoUsd !== this.limitNanoUsd ||
        !Number.isSafeInteger(state.reservedNanoUsd) || state.reservedNanoUsd < 0 ||
        !Number.isSafeInteger(state.attempts) || state.attempts < 0 || !Number.isSafeInteger(state.attempts + 1) ||
        state.reservedNanoUsd + amount > this.limitNanoUsd) throw new OpenCodeGoBudgetError()
      state.reservedNanoUsd += amount
      state.attempts += 1
      const file = await open(tempPath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
      await rename(tempPath, this.options.statePath)
      // Persist the rename before the caller is allowed to dispatch.
      const directory = await open(dirname(this.options.statePath), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch { throw new OpenCodeGoBudgetError() } finally {
      await unlink(tempPath).catch(() => undefined)
      await lock.close()
      await unlink(lockPath)
    }
  }
}
