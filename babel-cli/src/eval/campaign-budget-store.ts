import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  CampaignBudget,
  type CampaignBudgetSnapshot,
  PILOT_CAMPAIGN_LIMIT_MICRO_USD,
} from './campaign-budget.js'

export class CampaignBudgetStoreError extends Error {
  readonly code = 'CAMPAIGN_BUDGET_STORE_DENIED' as const
  constructor(message = 'Campaign budget store denied the mutation.') {
    super(message)
    this.name = 'CampaignBudgetStoreError'
  }
}

export interface CampaignBudgetStoreOptions {
  statePath: string
  campaignId: string
  limitMicroUsd?: number
  requireExistingState?: boolean
}

/** Cross-process campaign ledger; one atomic reserve/settle per locked transaction. */
export class CampaignBudgetStore {
  private readonly options: Readonly<CampaignBudgetStoreOptions>
  private stateEstablished = false

  constructor(options: CampaignBudgetStoreOptions) {
    if (!options.statePath.trim() || !options.campaignId.trim()) {
      throw new CampaignBudgetStoreError()
    }
    this.options = Object.freeze({
      limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
      ...options,
    })
  }

  private poisonPath(): string {
    return `${this.options.statePath}.poison`
  }

  private assertStoreHealthy(): void {
    if (existsSync(this.poisonPath())) {
      throw new CampaignBudgetStoreError()
    }
  }

  /** Campaign-wide fail-closed marker after ledger persistence could not complete. */
  persistPoisonMarker(): void {
    this.markStorePoisoned()
  }

  private markStorePoisoned(): void {
    try {
      mkdirSync(dirname(this.options.statePath), { recursive: true })
      const tempPath = `${this.poisonPath()}.${randomUUID()}.tmp`
      const fileFd = openSync(tempPath, 'wx', 0o600)
      try {
        writeFileSync(fileFd, JSON.stringify({ closedAtMs: Date.now() }), 'utf8')
        fsyncSync(fileFd)
      } finally {
        closeSync(fileFd)
      }
      renameSync(tempPath, this.poisonPath())
      const directoryFd = openSync(dirname(this.options.statePath), 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
    } catch {
      /* fail closed on next read */
    }
  }

  private loadSnapshot(bytes: string): CampaignBudgetSnapshot {
    const parsed = JSON.parse(bytes) as CampaignBudgetSnapshot
    return new CampaignBudget({
      campaignId: this.options.campaignId,
      limitMicroUsd: this.options.limitMicroUsd ?? PILOT_CAMPAIGN_LIMIT_MICRO_USD,
      snapshot: parsed,
    }).snapshot()
  }

  private acquireTransactionLock(lockPath: string): number {
    const deadlineMs = Date.now() + 5_000
    while (Date.now() < deadlineMs) {
      try {
        return openSync(lockPath, 'wx', 0o600)
      } catch {
        /* cross-process contention; retry until deadline */
      }
    }
    throw new CampaignBudgetStoreError()
  }

  transact<T>(mutate: (budget: CampaignBudget) => T): T {
    const lockPath = `${this.options.statePath}.lock`
    let lockFd: number | undefined
    try {
      lockFd = this.acquireTransactionLock(lockPath)
    } catch {
      throw new CampaignBudgetStoreError()
    }
    const tempPath = `${this.options.statePath}.${randomUUID()}.tmp`
    let mutated = false
    try {
      if (existsSync(this.poisonPath())) {
        throw new CampaignBudgetStoreError()
      }
      mkdirSync(dirname(this.options.statePath), { recursive: true })
      let budget: CampaignBudget
      try {
        const bytes = readFileSync(this.options.statePath, 'utf8')
        this.stateEstablished = true
        budget = new CampaignBudget({
          campaignId: this.options.campaignId,
          limitMicroUsd: this.options.limitMicroUsd ?? PILOT_CAMPAIGN_LIMIT_MICRO_USD,
          snapshot: this.loadSnapshot(bytes),
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          this.options.requireExistingState || this.stateEstablished) {
          throw new CampaignBudgetStoreError()
        }
        budget = new CampaignBudget({
          campaignId: this.options.campaignId,
          limitMicroUsd: this.options.limitMicroUsd ?? PILOT_CAMPAIGN_LIMIT_MICRO_USD,
        })
      }
      const result = mutate(budget)
      mutated = true
      const snapshot = budget.snapshot()
      const fileFd = openSync(tempPath, 'wx', 0o600)
      try {
        writeFileSync(fileFd, JSON.stringify(snapshot), 'utf8')
        fsyncSync(fileFd)
      } finally {
        closeSync(fileFd)
      }
      renameSync(tempPath, this.options.statePath)
      this.stateEstablished = true
      const directoryFd = openSync(dirname(this.options.statePath), 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
      return result
    } catch (error) {
      if (mutated) {
        this.markStorePoisoned()
      }
      if (error instanceof CampaignBudgetStoreError) throw error
      throw new CampaignBudgetStoreError()
    } finally {
      try { unlinkSync(tempPath) } catch { /* empty */ }
      if (lockFd !== undefined) {
        try { closeSync(lockFd) } catch { /* empty */ }
      }
      try { unlinkSync(lockPath) } catch { /* empty */ }
    }
  }

  async transactAsync<T>(mutate: (budget: CampaignBudget) => T): Promise<T> {
    await mkdir(dirname(this.options.statePath), { recursive: true })
    return this.transact(mutate)
  }

  readSnapshot(): CampaignBudgetSnapshot {
    this.assertStoreHealthy()
    if (!existsSync(this.options.statePath)) throw new CampaignBudgetStoreError()
    return this.loadSnapshot(readFileSync(this.options.statePath, 'utf8'))
  }
}

export function campaignBudgetStateDigest(snapshot: CampaignBudgetSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}
