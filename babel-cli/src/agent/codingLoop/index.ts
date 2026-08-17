/**
 * Shared coding-loop services used by Chat (and available to Deep).
 */

export {
  DEFAULT_READ_WINDOW_LINES,
  decideReadInjection,
  evaluateReadRequest,
  formatReadObservation,
  formatReadWindowBanner,
  invalidateReadCacheForPath,
  makeReadInjectionKey,
  readPathKey,
  rememberReadInjection,
  selectReadWindow,
  type ReadInjectionCache,
  type ReadInjectionDecision,
  type ReadRangeRequest,
  type ReadWindow,
} from './readWindow.js'

export {
  compileObservation,
  formatCompiledObservation,
  formatVerifierReceiptSummary,
  parseStructuredFailures,
  OBSERVATION_SPILL_THRESHOLD,
  type CompiledObservation,
} from './observationCompiler.js'

export {
  evaluatePostWriteRepairTurn,
  investigationToolsAvailable,
  INVESTIGATION_TOOL_NAMES,
  isUnproductiveRepeat,
  resolveNextTurnToolAccess,
  toolsForNextTurn,
  type NextTurnToolPolicy,
} from './postWritePolicy.js'

export {
  pairToolResultsByActionIdentity,
  rebuildPairedToolTurn,
  resolveDurableToolCallId,
} from './toolIdentity.js'

export {
  applyUniqueEdit,
  detectLineEnding,
  formatEditObservation,
  type EditApplyResult,
} from './editApply.js'

export {
  classifyFailureSurface,
  isRepeatedSameError,
  type FailureSurface,
  type FailureSurfaceKind,
  type RepairDiagnosis,
  type RepairDiagnosisKind,
} from './failureSurface.js'

export {
  applyWorkingStateEvent,
  createWorkingState,
  formatWorkingStateBlock,
  isWorkingStateMessage,
  preserveWorkingStateMessages,
  upsertWorkingStateMessage,
  WORKING_STATE_MARKER,
  WORKING_STATE_NAME,
  type WorkingState,
} from './workingState.js'

export {
  canAuthorizeVerifiedComplete,
  classifyFailureOrigin,
  classifyVerificationCommand,
  isCatOrTypeCommand,
  requiredStagesForRisk,
  riskLevelFromProfile,
  type RiskProfile,
  type VerificationStage,
} from './verificationStages.js'

export {
  attachMatchContext,
  buildBoundedRepoMap,
  formatSearchHits,
} from './navigation.js'

export { decideProgressIntervention } from './progressSignals.js'
