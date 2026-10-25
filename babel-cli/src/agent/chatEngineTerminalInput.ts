import type { ChatEngineOptions } from './chatEngineContracts.js'
import type { ChatExecutionProfile } from './chatEngineServices.js'
import type { ChatTaskClass } from '../config/chatTaskClass.js'
import type { ChatEngineLimits } from '../config/chatEngineLimits.js'
import type { ChatRunLimiter } from '../config/chatEngineLimits.js'
import type { VerificationPolicy } from '../config/chatTaskClass.js'
import type { TaskContractV1 } from './taskContract.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import type { DiffCriticVerdict } from './diffCritic.js'
import type { ChatMessage } from './chatToolDefinitions.js'
import type { ChatTurnTelemetryCollector, ChatTurnTelemetryRecord } from './chatTurnTelemetry.js'
import type { PolicyEventLog } from './policyEventLog.js'
import type { ObservabilityHandles } from './chatEngineObservability.js'
import type { ParityRuntime } from './chatEngineParityBridge.js'
import type { ThreadTerminalResponse } from './threadEventLog.js'
import type { CriterionCompletionServiceV1 } from '../authority/criterionCompletion.js'
import {
  finalizeParityTurnSync,
  type FinalizeParityTurnExtras,
  type FinalizeParityTurnResult,
} from './chatEngineParityBridge.js'
import type { ChatResult } from './chatEngineContracts.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import type { TerminalReason } from './chatTerminalReason.js'
import type { ExecutorKernel } from '../executor/kernel.js'
import type { ChatTerminalInput } from './chatEngineTerminalRuntime.js'
import { refreshNativePathListProofCompliant } from './criterionCompletionChatBridge.js'

export type ChatEngineTerminalInputHost = {
  options: ChatEngineOptions
  executionProfile: ChatExecutionProfile
  taskClass: ChatTaskClass
  engineRunId: string
  engineRunDir: string
  turnIndex: number
  turnId: string | null
  taskContract: TaskContractV1 | undefined
  acceptedOperation?: import('../config/chatTaskClass.js').TaskOperation | undefined
  hasAnyWrites: () => boolean
  isAcceptedReadOnlyTerminal: () => boolean
  budgetExceeded: boolean
  terminatingLimiter: ChatRunLimiter | null
  terminalLimiterReason: string | null
  lastVerifierReceipt: BoundChatVerifierReceipt | null
  gatePolicy: VerificationPolicy | null
  lastCriticReceipt: DiffCriticVerdict | null
  verifierTampered: boolean
  writeCount: number
  criterionCompletion?: CriterionCompletionServiceV1 | undefined
  conversation: ChatMessage[]
  cachedSystemPromptNative: string | null
  playbookId: string | null
  dedupeHitCount: number
  lastRequestPromptTokens: number | null
  lastRequestCompletionTokens: number | null
  lastRequestModelId: string | null
  currentTurnTelemetry: ChatTurnTelemetryCollector | null
  lastTurnTelemetry: ChatTurnTelemetryRecord | null
  parity: ParityRuntime
  policyEventLog: PolicyEventLog
  observabilityHandles: () => ObservabilityHandles
  limits: ChatEngineLimits
  postWriteRepairWallCapMs: number | null
  criticRepairCostCapUsd: number | null
  taskCostBaselineUsd: number
  decideCompletion: (
    requested: TerminalOutcome | 'PLAN_COMPLETE',
    hasMutation: boolean,
  ) => ReturnType<ExecutorKernel['completion']['decide']>
  settleActiveExecutionForTerminal: () => void
  isSubmissionCurrent: (generation: number) => boolean
  currentTaskCostUsd: () => number
  persistTaskCostBaseline: () => void
  storeTelemetry: (record: ChatTurnTelemetryRecord | null) => void
  setLimiter: (limiter: ChatRunLimiter, reason: string) => void
  setBudgetExceeded: () => void
}

export function buildChatEngineTerminalInput(host: ChatEngineTerminalInputHost): ChatTerminalInput {
  return {
    snapshot: {
      context: {
        options: host.options,
        executionProfile: host.executionProfile,
        taskClass: host.taskClass,
        engineRunId: host.engineRunId,
        engineRunDir: host.engineRunDir,
        turnIndex: host.turnIndex,
        turnId: host.turnId,
        taskContract: host.taskContract,
        acceptedOperation: host.acceptedOperation,
      },
      outcome: {
        hasMutation: host.hasAnyWrites(),
        readOnly: host.isAcceptedReadOnlyTerminal(),
        budgetExceeded: host.budgetExceeded,
        terminatingLimiter: host.terminatingLimiter,
        terminalLimiterReason: host.terminalLimiterReason,
        lastVerifierReceipt: host.lastVerifierReceipt,
        gatePolicy: host.gatePolicy,
        lastCriticReceipt: host.lastCriticReceipt,
        verifierTampered: host.verifierTampered,
        writeCount: host.writeCount,
        nativePathListVerified: refreshNativePathListProofCompliant(host.criterionCompletion),
      },
      presentation: {
        conversation: host.conversation,
        cachedSystemPromptNative: host.cachedSystemPromptNative,
        playbookId: host.playbookId,
        dedupeHitCount: host.dedupeHitCount,
        lastRequestPromptTokens: host.lastRequestPromptTokens,
        lastRequestCompletionTokens: host.lastRequestCompletionTokens,
        lastRequestModelId: host.lastRequestModelId,
        currentTurnTelemetry: host.currentTurnTelemetry,
        lastTurnTelemetry: host.lastTurnTelemetry,
      },
      evidence: {
        sessionEvents: host.parity.sessionEvents,
        policyEventLog: host.policyEventLog,
        observability: host.observabilityHandles(),
      },
      allowance: {
        limits: host.limits,
        postWriteRepairWallCapMs: host.postWriteRepairWallCapMs,
        criticRepairCostCapUsd: host.criticRepairCostCapUsd,
        taskCostBaselineUsd: host.taskCostBaselineUsd,
      },
    },
    effects: {
      decideCompletion: host.decideCompletion,
      settleActiveExecution: host.settleActiveExecutionForTerminal,
      finalizeTurn: (
        outcome: TerminalOutcome | undefined,
        status: ChatResult['status'],
        reason: TerminalReason | undefined,
        response?: ThreadTerminalResponse,
        extras?: FinalizeParityTurnExtras,
      ): FinalizeParityTurnResult =>
        finalizeParityTurnSync(
          host.parity,
          host.engineRunDir,
          outcome,
          status,
          reason,
          response,
          extras,
        ),
      storeTelemetry: host.storeTelemetry,
      setLimiter: host.setLimiter,
      setBudgetExceeded: host.setBudgetExceeded,
      isSubmissionCurrent: host.isSubmissionCurrent,
      currentTaskCostUsd: host.currentTaskCostUsd,
      persistTaskCostBaseline: host.persistTaskCostBaseline,
      nativePathListVerified: () =>
        refreshNativePathListProofCompliant(host.criterionCompletion),
    },
  }
}
