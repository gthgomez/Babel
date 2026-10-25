/** In-memory campaign spend ledger with optional durable snapshot callbacks. */

export const PILOT_CAMPAIGN_LIMIT_MICRO_USD = 10_000_000

export type CampaignBudgetSettleResult = 'settled' | 'unchanged' | 'bound_exceeded'

export interface CampaignBudgetOperationSnapshot {
  readonly operationId: string
  readonly upperBoundMicroUsd: number
  /** `null` while reserved or settled as unknown usage. */
  readonly actualMicroUsd: number | null
  readonly settledUnknown: boolean
}

export interface CampaignBudgetSnapshot {
  readonly campaignId: string
  readonly limitMicroUsd: number
  readonly admissionClosed: boolean
  readonly operations: readonly CampaignBudgetOperationSnapshot[]
}

export interface CampaignBudgetOptions {
  campaignId: string
  limitMicroUsd: number
  snapshot?: CampaignBudgetSnapshot
  persist?: (snapshot: CampaignBudgetSnapshot) => void
}

interface MutableOperation {
  operationId: string
  upperBoundMicroUsd: number
  actualMicroUsd: number | null
  settledUnknown: boolean
}

function assertIdentity(value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('identity')
  }
}

function assertReserveBound(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('amount')
  }
}

function assertSettledActual(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('amount')
  }
}

function assertLimitMicroUsd(limitMicroUsd: number): void {
  if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd < 0) {
    throw new Error('amount')
  }
}

function chargeMicroUsd(operation: MutableOperation): number {
  if (operation.actualMicroUsd !== null) {
    return operation.actualMicroUsd
  }
  return operation.upperBoundMicroUsd
}

function freezeSnapshot(input: {
  campaignId: string
  limitMicroUsd: number
  admissionClosed: boolean
  operations: MutableOperation[]
}): CampaignBudgetSnapshot {
  const operations = Object.freeze(
    input.operations.map((operation) =>
      Object.freeze({
        operationId: operation.operationId,
        upperBoundMicroUsd: operation.upperBoundMicroUsd,
        actualMicroUsd: operation.actualMicroUsd,
        settledUnknown: operation.settledUnknown,
      }),
    ),
  )
  return Object.freeze({
    campaignId: input.campaignId,
    limitMicroUsd: input.limitMicroUsd,
    admissionClosed: input.admissionClosed,
    operations,
  })
}

function mustCloseAdmission(operations: readonly MutableOperation[], limitMicroUsd: number): boolean {
  for (const operation of operations) {
    if (operation.actualMicroUsd !== null && operation.actualMicroUsd > operation.upperBoundMicroUsd) {
      return true
    }
  }
  const committed = operations.reduce((sum, operation) => sum + chargeMicroUsd(operation), 0)
  return limitMicroUsd - committed < 0
}

function validateImportedSnapshot(
  options: CampaignBudgetOptions,
  snapshot: CampaignBudgetSnapshot,
): { operations: MutableOperation[]; admissionClosed: boolean } {
  if (snapshot.campaignId !== options.campaignId || snapshot.limitMicroUsd !== options.limitMicroUsd) {
    throw new Error('snapshot identity')
  }
  assertLimitMicroUsd(snapshot.limitMicroUsd)
  if (typeof snapshot.admissionClosed !== 'boolean') {
    throw new Error('snapshot admission')
  }
  const seen = new Set<string>()
  const operations = snapshot.operations.map((operation) => {
    if (seen.has(operation.operationId)) {
      throw new Error('duplicate operation')
    }
    seen.add(operation.operationId)
    assertIdentity(operation.operationId)
    assertReserveBound(operation.upperBoundMicroUsd)
    if (operation.actualMicroUsd !== null) {
      assertSettledActual(operation.actualMicroUsd)
    }
    if (typeof operation.settledUnknown !== 'boolean') {
      throw new Error('snapshot identity')
    }
    if (operation.settledUnknown && operation.actualMicroUsd !== null) {
      throw new Error('snapshot admission')
    }
    return {
      operationId: operation.operationId,
      upperBoundMicroUsd: operation.upperBoundMicroUsd,
      actualMicroUsd: operation.actualMicroUsd,
      settledUnknown: operation.settledUnknown,
    }
  })
  const derivedAdmissionClosed = mustCloseAdmission(operations, snapshot.limitMicroUsd)
  if (snapshot.admissionClosed !== derivedAdmissionClosed) {
    throw new Error('snapshot admission')
  }
  return { operations, admissionClosed: snapshot.admissionClosed }
}

export class CampaignBudget {
  private readonly campaignId: string
  private readonly limitMicroUsd: number
  private readonly persist?: (snapshot: CampaignBudgetSnapshot) => void
  private readonly operations: MutableOperation[] = []
  private admissionClosed = false
  private mutating = false

  constructor(options: CampaignBudgetOptions) {
    assertIdentity(options.campaignId)
    assertLimitMicroUsd(options.limitMicroUsd)
    this.campaignId = options.campaignId
    this.limitMicroUsd = options.limitMicroUsd
    if (options.persist) {
      this.persist = options.persist
    }
    if (options.snapshot) {
      const imported = validateImportedSnapshot(options, options.snapshot)
      this.operations.push(...imported.operations)
      this.admissionClosed = imported.admissionClosed
    }
  }

  remainingMicroUsd(): number {
    const committed = this.operations.reduce((sum, operation) => sum + chargeMicroUsd(operation), 0)
    return this.limitMicroUsd - committed
  }

  reserve(operationId: string, upperBoundMicroUsd: number): boolean {
    assertIdentity(operationId)
    assertReserveBound(upperBoundMicroUsd)
    if (this.mutating) {
      throw new Error('mutation in progress')
    }
    if (this.admissionClosed || this.remainingMicroUsd() < 0) {
      return false
    }

    const existing = this.operations.find((operation) => operation.operationId === operationId)
    if (existing) {
      const settled = existing.actualMicroUsd !== null || existing.settledUnknown
      if (settled) {
        return false
      }
      if (existing.upperBoundMicroUsd !== upperBoundMicroUsd) {
        throw new Error('reservation conflict')
      }
      return false
    }

    if (this.remainingMicroUsd() < upperBoundMicroUsd) {
      return false
    }

    return this.commitMutation(() => {
      this.operations.push({
        operationId,
        upperBoundMicroUsd,
        actualMicroUsd: null,
        settledUnknown: false,
      })
      return true
    })
  }

  settle(operationId: string, actualMicroUsd: number | 'unknown'): CampaignBudgetSettleResult {
    assertIdentity(operationId)
    const existing = this.operations.find((operation) => operation.operationId === operationId)
    if (!existing) {
      throw new Error('reservation missing')
    }
    if (this.mutating) {
      throw new Error('mutation in progress')
    }

    if (actualMicroUsd === 'unknown') {
      if (existing.actualMicroUsd !== null) {
        return 'unchanged'
      }
      if (existing.settledUnknown) {
        return 'unchanged'
      }
      return this.commitMutation(() => {
        existing.settledUnknown = true
        return 'settled'
      })
    }

    assertSettledActual(actualMicroUsd)
    if (existing.actualMicroUsd !== null) {
      if (existing.actualMicroUsd === actualMicroUsd) {
        return 'unchanged'
      }
      throw new Error('settlement conflict')
    }
    if (existing.settledUnknown) {
      return this.commitMutation(() => {
        existing.settledUnknown = false
        existing.actualMicroUsd = actualMicroUsd
        if (actualMicroUsd > existing.upperBoundMicroUsd) {
          this.admissionClosed = true
          return 'bound_exceeded'
        }
        if (this.remainingMicroUsd() < 0) {
          this.admissionClosed = true
        }
        return 'settled'
      })
    }

    return this.commitMutation(() => {
      existing.actualMicroUsd = actualMicroUsd
      let result: CampaignBudgetSettleResult = 'settled'
      if (actualMicroUsd > existing.upperBoundMicroUsd) {
        this.admissionClosed = true
        result = 'bound_exceeded'
      }
      if (this.remainingMicroUsd() < 0) {
        this.admissionClosed = true
      }
      return result
    })
  }

  snapshot(): CampaignBudgetSnapshot {
    return freezeSnapshot({
      campaignId: this.campaignId,
      limitMicroUsd: this.limitMicroUsd,
      admissionClosed: this.admissionClosed,
      operations: this.operations.map((operation) => ({ ...operation })),
    })
  }

  private commitMutation<T>(mutate: () => T): T {
    const before = this.operations.map((operation) => ({ ...operation }))
    const admissionBefore = this.admissionClosed
    this.mutating = true
    try {
      const result = mutate()
      try {
        this.persist?.(this.snapshot())
      } catch (error) {
        const closedAdmission = this.admissionClosed
        this.operations.length = 0
        this.operations.push(...before)
        this.admissionClosed = admissionBefore
        if (closedAdmission && !admissionBefore) {
          this.admissionClosed = true
        }
        throw error
      }
      return result
    } finally {
      this.mutating = false
    }
  }
}
