import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, basename } from 'node:path'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'

/** Caller-owned persistent reservation state; never contains request data or credentials. */
export interface OpenCodeGoBudgetOptions {
  statePath: string
  jobId: string
  limitUsd: number
  /** A resumed charged task cannot initialize an absent reservation file. */
  requireExistingState?: boolean
  /** Trusted current effective task ceiling, bounded by the current grant. */
  currentLimitUsd?: () => number
  /** Existing owner-authorized grant renewal; the native USD 2 ceiling remains unchanged. */
  currentGrant?: () => { grantId: string; revision: number; limitUsd: number }
}

interface ReservationState {
  schema: 1
  jobId: string
  limitNanoUsd: number
  reservedNanoUsd: number
  attempts: number
  grantId?: string
  grantRevision?: number
}

/** Content-free, fail-closed budget error; callers must not select another provider. */
export class OpenCodeGoBudgetError extends Error {
  readonly code = 'GO_BUDGET_DENIED'
  constructor() {
    super('OpenCode Go budget denied the request.')
  }
}

/** Shared cross-process ledger. Reservations are durable before dispatch and never refunded. */
export class OpenCodeGoBudget {
  private stateEstablished = false
  private lastReservedNanoUsd = 0
  private lastGrant: { grantId: string; revision: number; limitNanoUsd: number } | null = null
  private readonly options: Readonly<OpenCodeGoBudgetOptions>
  constructor(options: OpenCodeGoBudgetOptions) {
    if (!isAbsolute(options.statePath) || !options.jobId.trim() ||
      !Number.isFinite(options.limitUsd) || options.limitUsd <= 0 || options.limitUsd > 2) {
      throw new OpenCodeGoBudgetError()
    }
    this.options = Object.freeze({ ...options })
  }

  private currentGrant(): { grantId: string; revision: number; limitNanoUsd: number } | null {
    const grant = this.options.currentGrant?.()
    if (!grant) return null
    if (!grant.grantId.trim() || !Number.isSafeInteger(grant.revision) || grant.revision < 0 ||
      !Number.isFinite(grant.limitUsd) || grant.limitUsd <= 0 || grant.limitUsd > 2) throw new OpenCodeGoBudgetError()
    const current = { grantId: grant.grantId, revision: grant.revision, limitNanoUsd: Math.floor(grant.limitUsd * 1e9) }
    if (this.lastGrant && (current.revision < this.lastGrant.revision ||
      (current.revision === this.lastGrant.revision && (current.grantId !== this.lastGrant.grantId || current.limitNanoUsd !== this.lastGrant.limitNanoUsd)) ||
      current.limitNanoUsd < this.lastGrant.limitNanoUsd)) throw new OpenCodeGoBudgetError()
    return current
  }

  private currentLimitNanoUsd(): number {
    const grantLimitNanoUsd = this.currentGrant()?.limitNanoUsd ?? Math.floor(this.options.limitUsd * 1e9)
    const currentLimitUsd = this.options.currentLimitUsd?.() ?? grantLimitNanoUsd / 1e9
    if (!Number.isFinite(currentLimitUsd) || currentLimitUsd <= 0 || Math.floor(currentLimitUsd * 1e9) > grantLimitNanoUsd) {
      throw new OpenCodeGoBudgetError()
    }
    return Math.floor(currentLimitUsd * 1e9)
  }

  /** Recheck the trusted task owner immediately before dispatch after asynchronous reservation. */
  assertCurrentAuthority(): void {
    if (this.lastReservedNanoUsd > this.currentLimitNanoUsd()) throw new OpenCodeGoBudgetError()
  }

  private reserveState(state: ReservationState, amount: number): ReservationState {
    const grant = this.currentGrant()
    const limitNanoUsd = grant?.limitNanoUsd ?? Math.floor(this.options.limitUsd * 1e9)
    if (state.schema !== 1 || state.jobId !== this.options.jobId ||
      !Number.isSafeInteger(state.limitNanoUsd) || state.limitNanoUsd <= 0 || state.limitNanoUsd > 2e9 ||
      (!grant && (state.limitNanoUsd !== limitNanoUsd || state.grantId !== undefined || state.grantRevision !== undefined)) ||
      (grant && (state.limitNanoUsd > grant.limitNanoUsd ||
        ((state.grantId !== undefined || state.grantRevision !== undefined) &&
          (typeof state.grantId !== 'string' || !state.grantId.trim() || !Number.isSafeInteger(state.grantRevision) || state.grantRevision! < 0 ||
            state.grantRevision! > grant.revision || (state.grantRevision === grant.revision &&
              (state.grantId !== grant.grantId || state.limitNanoUsd !== grant.limitNanoUsd)))))) ||
      !Number.isSafeInteger(state.reservedNanoUsd) || state.reservedNanoUsd < 0 ||
      state.reservedNanoUsd > state.limitNanoUsd || !Number.isSafeInteger(state.attempts) || state.attempts < 0 ||
      !Number.isSafeInteger(state.attempts + 1) || state.reservedNanoUsd + amount > this.currentLimitNanoUsd()) throw new OpenCodeGoBudgetError()
    return { ...state, limitNanoUsd, reservedNanoUsd: state.reservedNanoUsd + amount,
      attempts: state.attempts + (amount === 0 ? 0 : 1),
      ...(grant ? { grantId: grant.grantId, grantRevision: grant.revision } : {}) }
  }

  /** One Windows ledger, using Node's native SQLite VFS. Legacy bytes are retained as evidence only. */
  private async reserveWindows(amount: number): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    const statePath = this.options.statePath
    const physicalPath = join(realpathSync(dirname(statePath)), basename(statePath)).toLowerCase()
    const legacyPath = `${statePath}.legacy.json`
    const migrationLock = `${statePath}.migration.lock`
    const initial = (): ReservationState => ({ schema: 1, jobId: this.options.jobId,
      limitNanoUsd: this.currentGrant()?.limitNanoUsd ?? Math.floor(this.options.limitUsd * 1e9),
      reservedNanoUsd: 0, attempts: 0 })
    const transact = (path: string, seed?: ReservationState, legacyHash: string | null = null, debit = amount): ReservationState => {
      let db: SqliteDatabase | undefined
      let committed = false
      try {
        db = new DatabaseSync(path)
        // Exclusive access avoids concurrent WAL writers/checkpointers, including
        // SQLite <= 3.51.2's WAL-reset race: https://sqlite.org/wal.html#walreset
        if (db.prepare('PRAGMA locking_mode=EXCLUSIVE').get()?.locking_mode !== 'exclusive' ||
          db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') throw new OpenCodeGoBudgetError()
        db.exec('PRAGMA synchronous=FULL')
        db.exec('PRAGMA busy_timeout=0')
        if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new OpenCodeGoBudgetError()
        db.exec('BEGIN IMMEDIATE')
        if (seed) {
          db.exec('PRAGMA application_id=1111969585; PRAGMA user_version=1')
          db.exec('CREATE TABLE go_reservation (id INTEGER PRIMARY KEY CHECK(id=1), physical_path TEXT NOT NULL, legacy_sha256 TEXT, payload TEXT NOT NULL) STRICT')
          db.prepare('INSERT INTO go_reservation VALUES(1, ?, ?, ?)').run(physicalPath, legacyHash, JSON.stringify(seed))
        }
        if (db.prepare('PRAGMA application_id').get()?.application_id !== 1111969585 ||
          db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
          db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new OpenCodeGoBudgetError()
        const row = db.prepare('SELECT physical_path, payload FROM go_reservation WHERE id=1').get()
        if (!row || row.physical_path !== physicalPath) throw new OpenCodeGoBudgetError()
        const next = this.reserveState(JSON.parse(String(row.payload)) as ReservationState, debit)
        db.prepare('UPDATE go_reservation SET payload=? WHERE id=1').run(JSON.stringify(next))
        db.exec('COMMIT')
        committed = true
        // Closing checkpoints the exclusive WAL; failure still prevents dispatch.
        db.close()
        db = undefined
        return next
      } finally {
        if (db) {
          try { if (!committed) db.exec('ROLLBACK') } finally { db.close() }
        }
      }
    }
    try {
      if (existsSync(migrationLock)) throw new OpenCodeGoBudgetError()
      let seed: ReservationState | undefined
      if (!existsSync(statePath)) {
        if (this.options.requireExistingState || this.stateEstablished || existsSync(legacyPath) ||
          existsSync(`${statePath}-wal`) || existsSync(`${statePath}-shm`)) throw new OpenCodeGoBudgetError()
        // Exclusive creation makes an interrupted initial store fail closed, even
        // for another fresh caller without a resume marker.
        closeSync(openSync(statePath, 'wx', 0o600))
        seed = initial()
      } else {
        const stat = lstatSync(statePath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new OpenCodeGoBudgetError()
        const bytes = readFileSync(statePath)
        if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
          // An empty/corrupt interrupted SQLite store is never a fresh initializer.
          const legacy = this.reserveState(JSON.parse(bytes.toString('utf8')) as ReservationState, 0)
          if (existsSync(legacyPath)) throw new OpenCodeGoBudgetError()
          const lock = openSync(migrationLock, 'wx', 0o600)
          const temporary = `${statePath}.migration-${randomUUID()}`
          let migrated = false
          try {
            closeSync(openSync(temporary, 'wx', 0o600))
            transact(temporary, legacy, createHash('sha256').update(bytes).digest('hex'), 0)
            // Never overwrite the only original bytes or import the retained
            // backup automatically. Interrupted promotion stays blocked.
            renameSync(statePath, legacyPath)
            renameSync(temporary, statePath)
            migrated = true
          } finally {
            closeSync(lock)
            if (migrated) unlinkSync(migrationLock)
          }
        }
      }
      const next = transact(statePath, seed)
      this.stateEstablished = true
      this.lastReservedNanoUsd = next.reservedNanoUsd
      this.lastGrant = this.currentGrant()
    } catch { throw new OpenCodeGoBudgetError() }
  }

  /** Commit a non-refundable reservation before the caller may dispatch. */
  async reserve(inputBytes: number, maxOutputTokens: number): Promise<void> {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new OpenCodeGoBudgetError()
    const amount = inputBytes * 300 + maxOutputTokens * 1200
    const currentLimitNanoUsd = this.currentLimitNanoUsd()
    if (!Number.isSafeInteger(amount) || amount > currentLimitNanoUsd) throw new OpenCodeGoBudgetError()
    if (process.platform === 'win32') return this.reserveWindows(amount)
    const lockPath = `${this.options.statePath}.lock`
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch { throw new OpenCodeGoBudgetError() }
    const tempPath = `${this.options.statePath}.${randomUUID()}.tmp`
    try {
      const grant = this.currentGrant()
      const limitNanoUsd = grant?.limitNanoUsd ?? Math.floor(this.options.limitUsd * 1e9)
      let state: ReservationState = { schema: 1, jobId: this.options.jobId, limitNanoUsd, reservedNanoUsd: 0, attempts: 0 }
      try {
        const bytes = await readFile(this.options.statePath, 'utf8')
        this.stateEstablished = true
        state = JSON.parse(bytes) as typeof state
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          this.options.requireExistingState || this.stateEstablished) throw new OpenCodeGoBudgetError()
      }
      state = this.reserveState(state, amount)
      const file = await open(tempPath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
      await rename(tempPath, this.options.statePath)
      this.stateEstablished = true
      // Persist the rename before the caller is allowed to dispatch.
      const directory = await open(dirname(this.options.statePath), 'r')
      try { await directory.sync() } finally { await directory.close() }
      this.lastReservedNanoUsd = state.reservedNanoUsd
      this.lastGrant = this.currentGrant()
    } catch { throw new OpenCodeGoBudgetError() } finally {
      await unlink(tempPath).catch(() => undefined)
      await lock.close()
      await unlink(lockPath)
    }
  }
}
