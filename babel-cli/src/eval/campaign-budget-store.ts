import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
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

  private loadSnapshot(bytes: string): CampaignBudgetSnapshot {
    const parsed = JSON.parse(bytes) as CampaignBudgetSnapshot
    return new CampaignBudget({
      campaignId: this.options.campaignId,
      limitMicroUsd: this.options.limitMicroUsd ?? PILOT_CAMPAIGN_LIMIT_MICRO_USD,
      snapshot: parsed,
    }).snapshot()
  }

  transact<T>(mutate: (budget: CampaignBudget) => T): T {
    const lockPath = `${this.options.statePath}.lock`
    let lockFd: number | undefined
    try {
      lockFd = openSync(lockPath, 'wx', 0o600)
    } catch {
      throw new CampaignBudgetStoreError()
    }
    const tempPath = `${this.options.statePath}.${randomUUID()}.tmp`
    try {
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
    if (!existsSync(this.options.statePath)) {
      if (this.options.requireExistingState || this.stateEstablished) {
        throw new CampaignBudgetStoreError()
      }
      closeSync(openSync(this.options.statePath, 'wx', 0o600))
      const initial = new CampaignBudget({
        campaignId: this.options.campaignId,
        limitMicroUsd: this.options.limitMicroUsd ?? PILOT_CAMPAIGN_LIMIT_MICRO_USD,
      }).snapshot()
      await writeAtomic(this.options.statePath, JSON.stringify(initial))
      this.stateEstablished = true
    } else {
      const stat = lstatSync(this.options.statePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CampaignBudgetStoreError()
    }
    return this.transact(mutate)
  }

  readSnapshot(): CampaignBudgetSnapshot {
    if (!existsSync(this.options.statePath)) throw new CampaignBudgetStoreError()
    return this.loadSnapshot(readFileSync(this.options.statePath, 'utf8'))
  }
}

async function writeAtomic(path: string, payload: string): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`
  const file = await open(tempPath, 'wx', 0o600)
  try {
    await file.writeFile(payload)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tempPath, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export function campaignBudgetStateDigest(snapshot: CampaignBudgetSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}
