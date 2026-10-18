/**
 * Fresh-task isolation for applyPreparedUserSubmission — extracted from
 * chatEngine.ts to respect the file-size ratchet (R0-1 / S02 / P11 boundaries).
 */
import {
  selectPlaybookForChatTask,
  type PlaybookDefinition,
} from '../services/playbooks/playbookService.js'
import { shouldRequireTodoPlan } from './planThenExecute.js'
import { resolveChatInstructionContext } from './chatInstructionContext.js'
import { retireLiveCertificationForRun } from './toolExecutor.js'
import { refreshEngineInstructionManifest } from './chatEngineLiveSession.js'
import {
  createFailureBudgetTrackerFromContract,
  type FailureClassBudgetTracker,
} from './taskContract.js'
import { createWorkingState, type WorkingState } from './codingLoop/workingState.js'
import { createStallDetector, type StallState } from './stallDetector.js'
import type { ChatEngineOptions } from './chatEngineContracts.js'
import type { ChatCompiledStack } from './chatStackCompile.js'
import type { ChatEngineLimits, ChatRunLimiter } from '../config/chatEngineLimits.js'
import type { ChatExecutionProfile } from './chatEngineServices.js'
import type { ChatTaskClass } from '../config/chatTaskClass.js'
import type { ParityRuntime } from './chatEngineParityBridge.js'
import type { TurnRuntimeSnapshot } from './turnRuntime.js'
import type { PolicyEventLog } from './policyEventLog.js'
import type { ToolCallLogEntry } from './chatEngineObservability.js'

export interface FreshTaskIsolationHost {
  engineRunId: string
  engineRunDir: string
  executionProfile: ChatExecutionProfile
  taskClass: ChatTaskClass
  _turnIndex: number
  options: ChatEngineOptions
  limits: ChatEngineLimits
  parity: ParityRuntime
  progressController: { resetTaskLocal(): void }
  repetitionDetector: { reset(): void }
  policyEventLog: PolicyEventLog
  taskCostScopeUnavailable: boolean
  criticRepairCostCapUsd: number | null
  postWriteRepairWallCapMs: number | null
  postWriteRepairRestrict: boolean
  terminatingLimiter: ChatRunLimiter | null
  terminalLimiterReason: string | null
  workingState: WorkingState
  p11ObservationRefs: unknown[]
  p11ObservationCaptureIssues: unknown[]
  p11InstallBlock: unknown | null
  failureBudgetTracker: FailureClassBudgetTracker
  toolCallLog: ToolCallLogEntry[]
  _turnToolCallLogStart: number
  _logIndexToTurn: Map<number, number>
  _cancelled: boolean
  lastVerifierFailed: boolean
  investigateSoftNudgeDone: boolean
  childAttempts: Map<string, number>
  _lastPhase: import('./chatPhaseNudge.js').ChatPhase | null
  forceMutateTurnsOverride: number | null
  fullReadCounts: Map<string, number>
  cumulativeExplorationTools: number
  stallState: StallState
  activePlaybook: PlaybookDefinition | null
  requireTodoBeforeMutate: boolean
  clearVerifierEvidenceState(): void
  clearSystemPromptCache(): void
  resolveSubmissionLimits(runtime: TurnRuntimeSnapshot): ChatEngineLimits
  startIndependentTaskCostScope(): void
}

export function isolateEngineForFreshUserSubmission(
  host: FreshTaskIsolationHost,
  runtime: TurnRuntimeSnapshot,
  accepted?: {
    compiledChatStack?: ChatCompiledStack
  },
): void {
  retireLiveCertificationForRun(host.engineRunId)
  host.progressController.resetTaskLocal()
  host.taskCostScopeUnavailable = false
  host.criticRepairCostCapUsd = null
  host.postWriteRepairWallCapMs = null
  host.postWriteRepairRestrict = false
  host.terminatingLimiter = null
  host.terminalLimiterReason = null
  host.clearVerifierEvidenceState()
  host.workingState = createWorkingState(runtime.taskText.slice(0, 240))
  host.p11ObservationRefs = []
  host.p11ObservationCaptureIssues = []
  host.p11InstallBlock = null
  delete host.parity.contextCheckpoint
  host.failureBudgetTracker = createFailureBudgetTrackerFromContract(
    host.parity.liveAuthority?.taskContract,
  )
  host.toolCallLog = []
  host._turnToolCallLogStart = 0
  host._logIndexToTurn.clear()
  host._cancelled = false
  host.lastVerifierFailed = false
  host.investigateSoftNudgeDone = false
  host.childAttempts.clear()
  host._lastPhase = null
  host.forceMutateTurnsOverride = null
  host.fullReadCounts.clear()
  host.cumulativeExplorationTools = 0
  host.stallState = createStallDetector()
  host.repetitionDetector.reset()
  host.limits = host.resolveSubmissionLimits(runtime)
  if (!accepted) host.startIndependentTaskCostScope()
  host.activePlaybook = selectPlaybookForChatTask(runtime.taskText) ?? null
  host.requireTodoBeforeMutate = shouldRequireTodoPlan(
    runtime.taskText,
    host.activePlaybook,
  )
  const recompileOptions = { ...host.options }
  delete recompileOptions.compiledChatStack
  host.options = {
    ...host.options,
    compiledChatStack:
      accepted?.compiledChatStack ?? resolveChatInstructionContext(recompileOptions),
  }
  host.clearSystemPromptCache()
  if (!accepted && host.parity?.liveAuthority) {
    try {
      refreshEngineInstructionManifest({
        parity: host.parity,
        options: host.options,
        taskClass: host.taskClass,
        executionProfile: host.executionProfile,
        engineRunDir: host.engineRunDir,
      })
    } catch (err) {
      try {
        host.policyEventLog.record({
          at_turn: host._turnIndex,
          kind: 'progress_policy',
          detail: `instruction_manifest_refresh_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      } catch {
        /* telemetry must not fail the turn */
      }
    }
  }
}
