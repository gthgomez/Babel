import { sha256Canonical } from '../acceptance/canonical.js'
import {
  buildTaskContractV1,
  freezeTaskContract,
  validateTaskContractV1,
  OBJECTIVE_LIFECYCLE_REF,
  type TaskContractV1,
} from './taskContract.js'
import {
  validateTaskModeCompanion,
  MODE_REVISION_HISTORY_REF,
  type TaskModeHistory,
} from './taskModeRevision.js'
import type { ThreadEventLog } from './threadEventLog.js'
import type { SessionEventLog } from './sessionEvents.js'
import {assertCanonicalAcceptanceAmendments} from './taskAcceptanceSource.js'

export const TASK_OBJECTIVE_LIFECYCLE_FILENAME = 'task-objective-lifecycle.json'
export {OBJECTIVE_LIFECYCLE_REF} from './taskContract.js'
const MAX_OBJECTIVE_HISTORY_RECORDS = 100_000
export interface ObjectiveAuthorityRecord {
  taskContract: TaskContractV1
  taskModeHistory?: TaskModeHistory
}
export interface TaskAttemptBinding {
  task_id: string
  contract_id: string
  contract_hash: string
  attempt_id: string
}
export interface ObjectiveAttempt extends TaskAttemptBinding {
  turn_id: string
  submission_event_id: string
  admission_event_id: string
  input_digest: string
}
/** Authority history and references to canonical attempts, never a second event log. */
export interface TaskObjectiveLifecycleV1 {
  schema_version: 1
  active_task_id: string
  objectives: ObjectiveAuthorityRecord[]
  attempts: ObjectiveAttempt[]
}

export function requiresObjectiveLifecycle(contract: TaskContractV1): boolean {
  return contract.provenance.records.some(
    (record) =>
      record.kind === 'risk_analysis' && record.ref === OBJECTIVE_LIFECYCLE_REF,
  )
}

/** Add a hash-bound requirement without mutating the constructor's frozen seed. */
export function bindInitialObjective(
  authority: ObjectiveAuthorityRecord,
): ObjectiveAuthorityRecord {
  const current = authority.taskContract
  if (requiresObjectiveLifecycle(current)) return authority
  const modeHistory = authority.taskModeHistory ?? {
    schema_version: 1 as const,
    revisions: [current],
  }
  const contract = freezeTaskContract(
    buildTaskContractV1({
      ...current,
      provenance: [
        ...current.provenance.records,
        { kind: 'risk_analysis', ref: OBJECTIVE_LIFECYCLE_REF },
        { kind: 'risk_analysis', ref: MODE_REVISION_HISTORY_REF },
      ],
      source: 'taskObjectiveLifecycle',
      ...(modeHistory ? { parent_contract_id: current.contract_id } : {}),
      failure_class_budgets: current.budgets.failure_class_budgets,
      ...(current.budgets.max_turns !== undefined
        ? { max_turns: current.budgets.max_turns }
        : {}),
      ...(current.budgets.max_tokens !== undefined
        ? { max_tokens: current.budgets.max_tokens }
        : {}),
    }),
  )
  return {
    taskContract: contract,
    ...(modeHistory
      ? {
          taskModeHistory: {
            ...modeHistory,
            revisions: [...modeHistory.revisions, contract],
          },
        }
      : {}),
  }
}

export function assertTaskAttemptBinding(value: Record<string, unknown>): void {
  const fields = ['task_id', 'contract_id', 'contract_hash', 'attempt_id']
  if (fields.every((field) => value[field] === undefined)) return
  if (
    fields.some(
      (field) =>
        typeof value[field] !== 'string' ||
        (value[field] as string).length === 0 ||
        (value[field] as string).length > 512,
    ) ||
    !/^[0-9a-f]{32,64}$/.test(String(value['contract_hash']))
  )
    throw new Error(
      'OBJECTIVE_ATTEMPT_INVALID: Incomplete task/contract/attempt binding',
    )
}

/** Validate frozen authority and exact references; no authority is inferred from prose. */
export function assertObjectiveLifecycle(
  current: ObjectiveAuthorityRecord,
  lifecycle: TaskObjectiveLifecycleV1 | undefined,
  logs?: { thread: ThreadEventLog; session: SessionEventLog },
): void {
  if (!lifecycle) {
    if (requiresObjectiveLifecycle(current.taskContract))
      throw new Error('OBJECTIVE_LIFECYCLE_MISSING')
    return
  }
  if (
    lifecycle.schema_version !== 1 ||
    !Array.isArray(lifecycle.objectives) ||
    !lifecycle.objectives.length ||
    lifecycle.objectives.length > MAX_OBJECTIVE_HISTORY_RECORDS ||
    !Array.isArray(lifecycle.attempts) ||
    !lifecycle.attempts.length ||
    lifecycle.attempts.length > MAX_OBJECTIVE_HISTORY_RECORDS
  )
    throw new Error('OBJECTIVE_LIFECYCLE_INVALID')
  const tasks = new Set<string>(),
    contracts = new Map<string, TaskContractV1>()
  for (const objective of lifecycle.objectives) {
    const contract = objective?.taskContract
    if (
      !contract ||
      validateTaskContractV1(contract).length ||
      !contract.frozen ||
      !contract.task_id ||
      tasks.has(contract.task_id)
    )
      throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Frozen objective')
    tasks.add(contract.task_id)
    if (
      objective.taskModeHistory &&
      validateTaskModeCompanion(contract, objective.taskModeHistory).length
    )
      throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Mode lineage')
    if (
      !objective.taskModeHistory &&
      contract.provenance.records.some(
        (record) => record.ref === MODE_REVISION_HISTORY_REF,
      )
    )
      throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Missing mode lineage')
    for (const revision of objective.taskModeHistory?.revisions ?? [contract]) {
      if (contracts.has(revision.contract_id))
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Duplicate contract')
      contracts.set(revision.contract_id, revision)
    }
  }
  const active = lifecycle.objectives.at(-1)!
  if (
    lifecycle.active_task_id !== current.taskContract.task_id ||
    active.taskContract.task_id !== lifecycle.active_task_id ||
    sha256Canonical(active.taskContract) !==
      sha256Canonical(current.taskContract) ||
    sha256Canonical(active.taskModeHistory ?? null) !==
      sha256Canonical(current.taskModeHistory ?? null)
  )
    throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Active head')
  const startedByTurn = new Map(
    logs?.thread.events
      .filter((event) => event.kind === 'turn_started' && !event.context_copy)
      .map((event) => [event.turn_id, event]) ?? [],
  )
  const submittedById = new Map(
    logs?.session.events
      .filter((event) => event.kind === 'user_submitted')
      .map((event) => [event.event_id, event]) ?? [],
  )
  const admissionsById = new Map(
    logs?.thread.events
      .filter((event) => event.kind === 'task_attempt_admitted')
      .map((event) => [event.event_id, event]) ?? [],
  )
  const attempts = new Set<string>(),
    turns = new Set<string>(),
    submissions = new Set<string>()
  let lastAdmissionSeq = -1
  for (const attempt of lifecycle.attempts) {
    assertTaskAttemptBinding(attempt as unknown as Record<string, unknown>)
    const contract = contracts.get(attempt.contract_id)
    if (
      !contract ||
      contract.task_id !== attempt.task_id ||
      contract.contract_hash !== attempt.contract_hash ||
      attempts.has(attempt.attempt_id) ||
      turns.has(attempt.turn_id) ||
      submissions.has(attempt.submission_event_id) ||
      attempt.attempt_id === attempt.turn_id ||
      !/^[0-9a-f]{64}$/.test(attempt.input_digest)
    )
      throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Attempt reference')
    attempts.add(attempt.attempt_id)
    turns.add(attempt.turn_id)
    submissions.add(attempt.submission_event_id)
    if (logs) {
      const event = startedByTurn.get(attempt.turn_id),
        submission = submittedById.get(attempt.submission_event_id),
        admitted = admissionsById.get(attempt.admission_event_id)
      if (!event || !submission || !admitted)
        throw new Error(
          'OBJECTIVE_LIFECYCLE_INVALID: Canonical attempt missing',
        )
      if (event.kind !== 'turn_started' || submission.kind !== 'user_submitted')
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Canonical binding')
      if (
        admitted.kind !== 'task_attempt_admitted' ||
        admitted.turn_id !== attempt.turn_id ||
        admitted.submission_event_id !== attempt.submission_event_id ||
        admitted.input_digest !== attempt.input_digest ||
        event.seq >= admitted.seq || admitted.seq <= lastAdmissionSeq
      )
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Canonical admission')
      lastAdmissionSeq = admitted.seq
      for (const field of [
        'task_id',
        'contract_id',
        'contract_hash',
        'attempt_id',
      ] as const)
        if (
          event[field] !== attempt[field] ||
          submission[field] !== attempt[field] ||
          admitted[field] !== attempt[field]
        )
          throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Canonical binding')
      if (
        submission.turn_id !== attempt.turn_id ||
        sha256Canonical({
          task: event.task,
          requestedOperation: event.requestedOperation ?? 'AUTO',
          requestedTaskIntent: event.requestedTaskIntent ?? null,
          requestedContinueTask: event.requestedContinueTask ?? false,
        }) !== attempt.input_digest
      )
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Accepted input')
    }
  }
  if (logs) {
    const firstBound = Math.min(
      ...[...startedByTurn.values()]
        .filter(
          (event) =>
            event.kind === 'turn_started' && event.attempt_id !== undefined,
        )
        .map((event) => event.seq),
    )
    for (const event of startedByTurn.values())
      if (event.seq >= firstBound && !turns.has(event.turn_id))
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Unbound canonical turn')
    for (const event of submittedById.values())
      if (
        event.kind === 'user_submitted' &&
        event.attempt_id !== undefined &&
        !submissions.has(event.event_id)
      )
        throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Unbound submission')
    if (admissionsById.size !== attempts.size)
      throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Unbound admission')
  }
  if (lifecycle.attempts.at(-1)!.task_id !== lifecycle.active_task_id)
    throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Active attempt')
  assertCanonicalAcceptanceAmendments(lifecycle.objectives,lifecycle.attempts,logs)
}

/** A mode revision updates only the current immutable lineage projection. */
export function advanceObjectiveMode(
  lifecycle: TaskObjectiveLifecycleV1,
  authority: ObjectiveAuthorityRecord,
): TaskObjectiveLifecycleV1 {
  const previous = lifecycle.objectives.at(-1)!
  if (
    previous.taskContract.task_id !== authority.taskContract.task_id ||
    !authority.taskModeHistory?.revisions.some(
      (contract) =>
        contract.contract_hash === previous.taskContract.contract_hash,
    )
  )
    throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Unlinked mode revision')
  return {
    ...lifecycle,
    objectives: [
      ...lifecycle.objectives.slice(0, -1),
      { ...previous, ...authority },
    ],
  }
}

/** Historical task receipts remain archived but cannot certify the active task. */
export function activeObjectiveSessionLog(
  log: SessionEventLog,
  lifecycle: TaskObjectiveLifecycleV1 | undefined,
): SessionEventLog {
  if (!lifecycle) return log
  const turns = new Set(
    lifecycle.attempts
      .filter((attempt) => attempt.task_id === lifecycle.active_task_id)
      .map((attempt) => attempt.turn_id),
  )
  return {
    ...log,
    events: log.events.filter(
      (event) => event.turn_id !== null && turns.has(event.turn_id),
    ),
  }
}

/** Acceptance changes retire old certification without discarding task context/effects. */
export function activeAcceptanceSessionLog(log:SessionEventLog,lifecycle:TaskObjectiveLifecycleV1|undefined):SessionEventLog{
  const taskLog=activeObjectiveSessionLog(log,lifecycle)
  const history=lifecycle?.objectives.at(-1)?.taskModeHistory
  if(!lifecycle||history?.schema_version!==2)return taskLog
  let start=0
  for(const [index,edge] of history.edges.entries())if(edge.kind==='acceptance')start=index+1
  const contracts=new Set(history.revisions.slice(start).map(contract=>contract.contract_id))
  const turns=new Set(lifecycle.attempts.filter(attempt=>attempt.task_id===lifecycle.active_task_id&&contracts.has(attempt.contract_id)).map(attempt=>attempt.turn_id))
  return {...taskLog,events:taskLog.events.filter(event=>event.turn_id!==null&&turns.has(event.turn_id))}
}
