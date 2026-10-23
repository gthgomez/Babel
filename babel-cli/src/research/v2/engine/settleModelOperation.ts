import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import type { ResearchStore } from '../ports/researchStore.js'
import { settleExternalOperation, unknownUsageSettlement } from './settleExternalOperation.js'

function diagnosticsForResult(
  modelResult: ResearchModelInvocationResult,
): import('../contracts/providerInvokeDiagnostics.js').ProviderInvokeDiagnostics | undefined {
  if (modelResult.status === 'ok') {
    return (
      modelResult.providerInvokeDiagnostics ?? modelResult.receipt.provider_invoke_diagnostics
    )
  }
  if (
    modelResult.status === 'failed' ||
    modelResult.status === 'cancelled' ||
    modelResult.status === 'uncertain'
  ) {
    return modelResult.providerInvokeDiagnostics
  }
  return undefined
}

function usageForResult(
  modelResult: ResearchModelInvocationResult,
  attemptId: string,
): import('../ports/researchModelPort.js').UsageSettlement | undefined {
  if (modelResult.status === 'ok') {
    return modelResult.receipt.usage_settlement
  }
  if (
    modelResult.status === 'failed' ||
    modelResult.status === 'cancelled' ||
    modelResult.status === 'uncertain'
  ) {
    return modelResult.usageSettlement
  }
  return unknownUsageSettlement(attemptId)
}

/** Planning-aligned model operation settlement (intent receipt + usage on every outcome). */
export async function settleModelOperation(
  store: ResearchStore,
  ctx: MissionWriteContext,
  missionId: string,
  operationId: string,
  attemptId: string,
  modelResult: ResearchModelInvocationResult,
  completedAt: string,
): Promise<void> {
  const usage = usageForResult(modelResult, attemptId) ?? unknownUsageSettlement(attemptId)
  const providerInvokeDiagnostics = diagnosticsForResult(modelResult)
  const diagnosticsFields = providerInvokeDiagnostics
    ? { provider_invoke_diagnostics: providerInvokeDiagnostics }
    : {}
  if (modelResult.status === 'ok') {
    await settleExternalOperation(
      store,
      ctx,
      missionId,
      operationId,
      attemptId,
      { settlement: 'succeeded', usage_settlement: usage, ...diagnosticsFields },
      completedAt,
    )
    return
  }
  if (modelResult.status === 'cancelled') {
    await settleExternalOperation(
      store,
      ctx,
      missionId,
      operationId,
      attemptId,
      { settlement: 'cancelled', usage_settlement: usage, ...diagnosticsFields },
      completedAt,
    )
    return
  }
  if (modelResult.status === 'uncertain') {
    await settleExternalOperation(
      store,
      ctx,
      missionId,
      operationId,
      attemptId,
      {
        settlement: 'uncertain',
        usage_settlement: usage,
        message: modelResult.message,
        ...diagnosticsFields,
      },
      completedAt,
    )
    return
  }
  await settleExternalOperation(
    store,
    ctx,
    missionId,
    operationId,
    attemptId,
    {
      settlement: 'failed',
      usage_settlement: usage,
      failureCategory: modelResult.failureCategory,
      message: modelResult.message,
      ...diagnosticsFields,
    },
    completedAt,
  )
}
