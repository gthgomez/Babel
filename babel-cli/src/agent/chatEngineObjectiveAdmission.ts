import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '../acceptance/canonical.js'
import type {
  ChatEngineOptions,
  ChatTaskAllowanceSnapshot,
} from './chatEngineContracts.js'
import type {
  PreparedUserSubmission,
  TurnRuntimeSnapshot,
  UserSubmissionInput,
} from './turnRuntime.js'
import {
  checkpointParityEventLogStrictSync,
  parityOnUserTurn,
  type ParityRuntime,
} from './chatEngineParityBridge.js'
import {
  evaluateSubmitTaskAuthorityHalt,
  hydrateRetainedModeSources,
  prepareEngineInstructionAuthority,
} from './chatEngineLiveSession.js'
import { assertPathListSessionBinding } from './liveSessionFilesystemPathListAdmission.js'
import { augmentInstructionManifestWithHostPathListClarification } from './pathListHostDeclaredClarification.js'
import {
  bindInitialObjective,
  assertObjectiveLifecycle,
  type ObjectiveAuthorityRecord,
  type TaskObjectiveLifecycleV1,
} from './taskObjectiveLifecycle.js'
import { publishDeferredSessionObservations } from './sessionEvents.js'
import type { ChatCompiledStack } from './chatStackCompile.js'
import { appendThreadEvent } from './threadEventLog.js'
import {createTaskAcceptanceRevision,isLegacyAcceptancePlaceholder} from './taskAcceptanceRevision.js'
import {appendTaskAcceptanceRevision} from './taskModeRevision.js'

type HaltEvent = NonNullable<ReturnType<typeof evaluateSubmitTaskAuthorityHalt>>
export type ObjectiveAdmissionResult =
  | { status: 'committed'; runtime: TurnRuntimeSnapshot }
  | { status: 'halted'; haltEvent: HaltEvent }
export interface ObjectiveAdmissionHost {
  parity: ParityRuntime
  options: ChatEngineOptions
  executionProfile: string
  readonly engineRunDir: string
  objectiveAdmissionBlocked: boolean
  activeSubmissionGeneration: number
  isSubmissionCurrent(generation: number): boolean
  currentP11Owner():
    | import('../runtime/contextCheckpoints.js').ContextCheckpointOwnerV1
    | null
  prepareUserSubmission(input: UserSubmissionInput): PreparedUserSubmission
  prepareSubmissionAllowance(
    prepared: PreparedUserSubmission,
    taskId: string,
  ): ChatTaskAllowanceSnapshot
  applyPreparedUserSubmission(
    prepared: PreparedUserSubmission,
    accepted: {
      allowance: ChatTaskAllowanceSnapshot
      acceptanceChanged?: boolean
      compiledChatStack?: ChatCompiledStack
    },
  ): TurnRuntimeSnapshot
}

export interface PreparedObjectiveSubmission {
  submission: PreparedUserSubmission
  taskId: string
  previousContractHash: string
}

/** Select one identity before durable command admission, without changing state. */
export function prepareObjectiveSubmission(
  host: ObjectiveAdmissionHost,
  input: UserSubmissionInput,
): PreparedObjectiveSubmission {
  const authority = host.parity.liveAuthority
  if (!authority) throw new Error('OBJECTIVE_AUTHORITY_MISSING')
  const submission = host.prepareUserSubmission(input)
  const retainIdentity =
    submission.objectiveDisposition === 'preserve' ||
    (submission.objectiveDisposition === 'initial' &&
      !authority.taskObjectiveLifecycle &&
      authority.taskContract.user_request === submission.runtime.taskText)
  return {
    submission,
    taskId: retainIdentity
      ? authority.taskContract.task_id
      : `task:${randomUUID()}`,
    previousContractHash: authority.taskContract.contract_hash,
  }
}

function objectiveRecord(
  authority: ObjectiveAuthorityRecord,
): ObjectiveAuthorityRecord {
  return {
    taskContract: authority.taskContract,
    ...(authority.taskModeHistory
      ? { taskModeHistory: authority.taskModeHistory }
      : {}),
  }
}

/** Stage acceptance and its canonical first attempt before changing live state. */
export function admitObjectiveSubmission(
  host: ObjectiveAdmissionHost,
  input: UserSubmissionInput,
  route: { model: string; provider: string },
  preview?: PreparedObjectiveSubmission,
): ObjectiveAdmissionResult {
  if (host.objectiveAdmissionBlocked)
    throw new Error(
      'OBJECTIVE_RELOAD_REQUIRED: Reopen the committed session before continuing',
    )
  const generation = host.activeSubmissionGeneration,
    owner = host.currentP11Owner()
  const assertOwnerCurrent = () => {
    if (!host.isSubmissionCurrent(generation))
      throw new Error('OBJECTIVE_OWNER_STALE')
    if (owner) {
      const current = host.currentP11Owner()
      if (
        !current ||
        current.threadId !== owner.threadId ||
        current.generation !== owner.generation ||
        current.token !== owner.token
      )
        throw new Error('OBJECTIVE_OWNER_STALE')
    }
  }
  const objective = preview ?? prepareObjectiveSubmission(host, input)
  if (
    objective.previousContractHash !==
      host.parity.liveAuthority?.taskContract.contract_hash ||
    sha256Canonical(objective.submission.input) !== sha256Canonical(input)
  )
    throw new Error('OBJECTIVE_PREPARATION_STALE')
  const prepared = objective.submission,
    runtime = prepared.runtime,
    previous = host.parity
  const staged: ParityRuntime = {
    ...previous,
    eventLog: structuredClone(previous.eventLog),
    sessionEvents: {
      ...previous.sessionEvents,
      events: structuredClone(previous.sessionEvents.events),
      deferObservations: true,
    },
    episodeStream: structuredClone(previous.episodeStream),
    loop: structuredClone(previous.loop),
    progress: structuredClone(previous.progress),
    authorizedObservationIds: new Set(previous.authorizedObservationIds),
  }
  const authority = previous.liveAuthority
  if (!authority) throw new Error('OBJECTIVE_AUTHORITY_MISSING')
  let options: ChatEngineOptions = { ...host.options, task: runtime.taskText }
  const context = {
    parity: staged,
    options,
    taskClass: runtime.taskClass,
    executionProfile: host.executionProfile,
    engineRunDir: host.engineRunDir,
  }
  if (options.resumeExisting || options.retainedHistory)
    hydrateRetainedModeSources(context)
  const firstSeq = staged.sessionEvents.nextSeq
  const halt = evaluateSubmitTaskAuthorityHalt(staged, input.userInput)
  if (halt) {
    if (staged.taskAuthorityGate)
      previous.taskAuthorityGate = staged.taskAuthorityGate
    else delete previous.taskAuthorityGate
    if (staged.pendingTaskClarification)
      previous.pendingTaskClarification = staged.pendingTaskClarification
    else delete previous.pendingTaskClarification
    return { status: 'halted', haltEvent: halt }
  }
  const lifecycle = authority.taskObjectiveLifecycle
  const initialSeed =
    prepared.objectiveDisposition === 'initial' &&
    !lifecycle &&
    authority.taskContract.user_request === runtime.taskText
  const preserve = prepared.objectiveDisposition === 'preserve'
  if (!preserve && !initialSeed) staged.authorizedObservationIds = new Set()
  if ((preserve || initialSeed) && authority.filesystemPathListAdmission) {
    if (options.trustedHostFilesystemPathListDeclaration !== undefined) {
      assertPathListSessionBinding({
        projectRoot: options.projectRoot,
        task: runtime.taskText,
        contract: authority.taskContract,
        admission: authority.filesystemPathListAdmission,
        incomingDeclaration: options.trustedHostFilesystemPathListDeclaration,
      })
    }
    const { trustedHostFilesystemPathListDeclaration: _pathListDecl, ...stripped } = options
    options = stripped
    context.options = options
  }
  let candidate: typeof authority
  if (preserve || initialSeed) {
    const delivered = prepareEngineInstructionAuthority(context)
    if (delivered.taskContract.mode !== authority.taskContract.mode) {
      throw new Error('MODE_TRANSITION_REQUIRED')
    }
    const pathListAdmission = authority.filesystemPathListAdmission
    candidate = {
      ...authority,
      instructionManifest: pathListAdmission
        ? augmentInstructionManifestWithHostPathListClarification(
            delivered.instructionManifest,
            pathListAdmission.declaration,
          )
        : delivered.instructionManifest,
      ...(delivered.chatStack ? { chatStack: delivered.chatStack } : {}),
    }
  } else {
    delete options.compiledChatStack
    context.options = options
    candidate = prepareEngineInstructionAuthority({
      ...context,
      options,
      taskId: objective.taskId,
      objectiveLifecycle: true,
    })
    // An unrelated task does not turn a Plan-only lease into execution authority.
    if (
      authority.taskContract.mode === 'plan' &&
      (authority.taskModeHistory?.revisions[0]?.mode ?? 'plan') === 'plan' &&
      candidate.taskContract.mode !== 'plan'
    )
      throw new Error('MODE_EXECUTION_AUTHORITY_REQUIRED')
    // Replace the previous task's mode companion with the new root in the same batch.
    if (authority.taskModeHistory)
      candidate.taskModeHistory = {
        schema_version: 1,
        revisions: [candidate.taskContract],
      }
  }
  const marked = bindInitialObjective(candidate)
  candidate = { ...candidate, ...marked }
  const requestedOperation = input.operation ?? options.operation ?? 'AUTO'
  const inputDigest = sha256Canonical({
    task: input.userInput,
    requestedOperation,
    requestedTaskIntent: input.taskIntent ?? null,
    requestedContinueTask: input.continueTask === true,
  })
  const attemptId=randomUUID()
  const amendments: NonNullable<ReturnType<typeof createTaskAcceptanceRevision>>[] = []
  const acceptRevision = (amendment: ReturnType<typeof createTaskAcceptanceRevision>) => {
    if (!amendment) return
    candidate.taskModeHistory=appendTaskAcceptanceRevision(candidate.taskModeHistory??{schema_version:1,revisions:[candidate.taskContract]},amendment.contract,amendment.descriptor)
    candidate.taskContract=amendment.contract
    delete staged.contextCheckpoint
    amendments.push(amendment)
  }
  if (preserve && isLegacyAcceptancePlaceholder(candidate.taskContract)) {
    const original = lifecycle?.attempts.find(attempt => attempt.task_id === candidate.taskContract.task_id &&
      staged.eventLog.events.some(event => event.kind === 'turn_started' && !event.context_copy &&
        event.turn_id === attempt.turn_id && event.task === candidate.taskContract.user_request))
    if (!original) throw new Error('TASK_ACCEPTANCE_INITIALIZATION_UNAVAILABLE: The original canonical request is required')
    acceptRevision(createTaskAcceptanceRevision(candidate.taskContract, {
      userInput: candidate.taskContract.user_request, inputDigest: original.input_digest, attemptId: original.attempt_id,
    }, 'initialize'))
    const starts = new Map(staged.eventLog.events.filter(event => event.kind === 'turn_started' && !event.context_copy).map(event => [event.turn_id, event]))
    for (const source of lifecycle!.attempts) {
      if (source.task_id !== candidate.taskContract.task_id || source.attempt_id === original.attempt_id) continue
      const started = starts.get(source.turn_id)
      if (!started || started.kind !== 'turn_started') throw new Error('TASK_ACCEPTANCE_INITIALIZATION_UNAVAILABLE')
      acceptRevision(createTaskAcceptanceRevision(candidate.taskContract, {
        userInput: started.task, inputDigest: source.input_digest, attemptId: source.attempt_id,
      }, 'migrate_addition'))
    }
  }
  if (preserve) acceptRevision(createTaskAcceptanceRevision(candidate.taskContract, {
    userInput: input.userInput, inputDigest, attemptId,
  }))
  const binding = {
    task_id: candidate.taskContract.task_id,
    contract_id: candidate.taskContract.contract_id,
    contract_hash: candidate.taskContract.contract_hash,
    attempt_id: attemptId,
  }
  parityOnUserTurn(staged, {
    task: input.userInput,
    ...route,
    projectRoot: options.projectRoot,
    ...(options.executionScope
      ? { executionScope: options.executionScope }
      : {}),
    policyPreset:
      options.executionScope?.kind === 'conversation'
        ? 'conversation_only'
        : 'workspace_write',
    taskClass: runtime.taskClass,
    gatePolicy: runtime.gatePolicy ?? 'required',
    submissionIndex: runtime.submissionIndex,
    continuedTask: runtime.continuedTask,
    requestedOperation,
    ...(input.taskIntent !== undefined
      ? { requestedTaskIntent: input.taskIntent }
      : {}),
    requestedContinueTask: input.continueTask === true,
    taskAttempt: binding,
  })
  const submitted = [...staged.sessionEvents.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'user_submitted' && event.turn_id === staged.turnId,
    )
  if (!submitted || !staged.turnId) throw new Error('OBJECTIVE_ATTEMPT_MISSING')
  const admitted = appendThreadEvent(staged.eventLog, {
    ...binding,
    kind: 'task_attempt_admitted',
    turn_id: staged.turnId,
    submission_event_id: submitted.event_id,
    input_digest: inputDigest,
  })
  for (const amendment of amendments) appendThreadEvent(staged.eventLog,{
    ...binding,kind:'task_acceptance_amended',turn_id:staged.turnId,
    submission_event_id:submitted.event_id,admission_event_id:admitted.event_id,
    input_digest:inputDigest,result_contract_id:amendment.contract.contract_id,result_contract_hash:amendment.contract.contract_hash,
    descriptor_digest:sha256Canonical(amendment.descriptor),descriptor:amendment.descriptor,
  })
  const objectives = lifecycle ? [...lifecycle.objectives] : []
  if (preserve || initialSeed) {
    if (objectives.length)
      objectives[objectives.length - 1] = {
        ...objectives.at(-1),
        ...objectiveRecord(candidate),
      }
    else objectives.push(objectiveRecord(candidate))
  } else {
    if (!objectives.length) objectives.push(objectiveRecord(authority))
    objectives.push(objectiveRecord(candidate))
  }
  const nextLifecycle: TaskObjectiveLifecycleV1 = {
    ...lifecycle,
    schema_version: 1,
    active_task_id: binding.task_id,
    objectives,
    attempts: [
      ...(lifecycle?.attempts ?? []),
      {
        ...binding,
        turn_id: staged.turnId,
        submission_event_id: submitted.event_id,
        admission_event_id: admitted.event_id,
        input_digest: inputDigest,
      },
    ],
  }
  candidate.taskObjectiveLifecycle = nextLifecycle
  staged.liveAuthority = candidate
  if (!runtime.continuedTask) delete staged.contextCheckpoint
  assertObjectiveLifecycle(candidate, nextLifecycle, {
    thread: staged.eventLog,
    session: staged.sessionEvents,
  })
  const allowance = host.prepareSubmissionAllowance(prepared, binding.task_id)
  const receipt = checkpointParityEventLogStrictSync(
    staged,
    host.engineRunDir,
    { taskAllowance: allowance, assertOwnerCurrent },
  )
  if (receipt.status !== 'committed')
    throw new Error(
      'OBJECTIVE_ADMISSION_NOT_COMMITTED: The previous objective is retained; repair session storage before retrying',
    )
  host.parity = staged
  try {
    const installed = host.applyPreparedUserSubmission(prepared, {
      allowance,
      acceptanceChanged: amendments.length > 0,
      ...(candidate.chatStack
        ? { compiledChatStack: candidate.chatStack }
        : {}),
    })
    publishDeferredSessionObservations(staged.sessionEvents, firstSeq)
    return { status: 'committed', runtime: installed }
  } catch {
    host.objectiveAdmissionBlocked = true
    throw new Error(
      'OBJECTIVE_RELOAD_REQUIRED: Acceptance was saved; reopen the session before continuing',
    )
  }
}
