import { sha256Canonical } from '../acceptance/canonical.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { isAcceptanceAddition } from './taskAcceptanceRevision.js'
import type { ObjectiveAuthorityRecord, ObjectiveAttempt } from './taskObjectiveLifecycle.js'
import type { ThreadEventLog, ThreadEvent } from './threadEventLog.js'
import type { SessionEventLog } from './sessionEvents.js'

/** Semantic revisions require their actual, uniquely accepted canonical input. */
export function assertCanonicalAcceptanceAmendments(
  objectives: readonly ObjectiveAuthorityRecord[],
  attempts: readonly ObjectiveAttempt[],
  logs?: { thread: ThreadEventLog; session: SessionEventLog },
): void {
  const edges = objectives.flatMap(objective => {
    const history = objective.taskModeHistory
    return history?.schema_version === 2 ? history.edges.flatMap((edge, index) =>
      edge.kind === 'acceptance' ? [{ descriptor: edge.descriptor, index,
        previous: history.revisions[index]!, current: history.revisions[index + 1]! }] : []) : []
  })
  type AmendmentEvent = Extract<ThreadEvent, { kind: 'task_acceptance_amended' }>
  const events = (logs?.thread.events.filter(event => event.kind === 'task_acceptance_amended' && !event.context_copy) ?? []) as AmendmentEvent[]
  function fail(): never { throw new Error('OBJECTIVE_LIFECYCLE_INVALID: Acceptance amendment source is missing, copied, duplicated or mismatched') }
  if (edges.length !== events.length || edges.length && !logs) fail()
  if (!edges.length) return
  const byAttempt = new Map(attempts.map((attempt, index) => [attempt.attempt_id, { attempt, index }]))
  const byDescriptor = new Map<string, AmendmentEvent>()
  for (const event of events) {
    if (byDescriptor.has(event.descriptor.amendment_id)) fail()
    byDescriptor.set(event.descriptor.amendment_id, event)
  }
  const starts = new Map<string, Extract<ThreadEvent, {kind:'turn_started'}>>()
  const admissions = new Map(logs!.thread.events.filter(item=>item.kind==='task_attempt_admitted').map(item=>[item.event_id,item]))
  for (const item of logs!.thread.events) {
    if (item.kind !== 'turn_started' || item.context_copy) continue
    if (starts.has(item.turn_id)) fail()
    starts.set(item.turn_id,item)
  }
  const submissions = new Map(logs!.session.events.filter(item => item.kind === 'user_submitted').map(item => [item.event_id, item]))
  const sourceIds = new Set<string>(), descriptorIds = new Set<string>(), published = new Set<string>()
  let lastPublisherIndex = -1, lastAmendmentSeq = -1
  let group: { publisher: ObjectiveAttempt; lastIndex: number; lastSeq: number; lastContract: string; initialized: boolean; lastSourceIndex: number; pendingMigrations: string[] } | undefined
  const finishGroup = () => {
    if (group && (group.lastContract !== group.publisher.contract_id || group.pendingMigrations.length)) fail()
  }
  for (const { descriptor, index, previous, current } of edges) {
    if (descriptorIds.has(descriptor.amendment_id) || sourceIds.has(descriptor.source_attempt_id)) fail()
    descriptorIds.add(descriptor.amendment_id)
    sourceIds.add(descriptor.source_attempt_id)
    const sourceRecord = byAttempt.get(descriptor.source_attempt_id)
    const event = byDescriptor.get(descriptor.amendment_id)
    if (!sourceRecord || !event) fail()
    const publisherRecord = byAttempt.get(event.attempt_id)
    if (!publisherRecord) fail()
    const source = sourceRecord.attempt, publisher = publisherRecord.attempt
    const sourceStart=starts.get(source.turn_id),sourceAdmission=admissions.get(source.admission_event_id)
    const publisherStart=starts.get(publisher.turn_id),publisherAdmission=admissions.get(publisher.admission_event_id)
    if(!sourceStart||!sourceAdmission||!publisherStart||!publisherAdmission||
      sourceStart.seq>=sourceAdmission.seq||publisherStart.seq>=publisherAdmission.seq||
      sourceAdmission.seq>publisherAdmission.seq||publisherAdmission.seq>=event.seq)fail()
    if (!group || group.publisher.attempt_id !== publisher.attempt_id) {
      finishGroup()
      if (published.has(publisher.attempt_id) || publisherRecord.index <= lastPublisherIndex) fail()
      published.add(publisher.attempt_id)
      lastPublisherIndex = publisherRecord.index
      group = { publisher, lastIndex: index - 1, lastSeq: -1, lastContract: '', initialized: false, lastSourceIndex: -1, pendingMigrations: [] }
    }
    const admitted = admissions.get(publisher.admission_event_id)
    if (!admitted || admitted.kind !== 'task_attempt_admitted' || event.seq <= admitted.seq || event.seq <= lastAmendmentSeq ||
      index !== group.lastIndex + 1 || event.seq <= group.lastSeq ||
      source.task_id !== current.task_id || publisher.task_id !== current.task_id ||
      event.result_contract_id !== current.contract_id || event.result_contract_hash !== current.contract_hash ||
      event.turn_id !== publisher.turn_id || event.submission_event_id !== publisher.submission_event_id ||
      event.admission_event_id !== publisher.admission_event_id || event.input_digest !== publisher.input_digest ||
      event.descriptor_digest !== sha256Canonical(descriptor) || sha256Canonical(event.descriptor) !== sha256Canonical(descriptor)) fail()
    for (const field of ['task_id', 'contract_id', 'contract_hash', 'attempt_id'] as const)
      if (event[field] !== publisher[field]) fail()
    const started = starts.get(source.turn_id), submitted = submissions.get(source.submission_event_id)
    if (!started || started.kind !== 'turn_started' || !submitted || submitted.kind !== 'user_submitted' ||
      descriptor.input_digest !== source.input_digest || descriptor.text_digest !== sha256Canonical(started.task) ||
      submitted.task_preview !== started.task.slice(0, 500)) fail()
    if (descriptor.kind === 'initialize') {
      const first = attempts.find(attempt => attempt.task_id === source.task_id)
      if (group.lastSeq !== -1 || sourceRecord.index >= publisherRecord.index ||
        first?.attempt_id !== source.attempt_id || started.task !== previous.user_request) fail()
      group.initialized = true
      const descriptions = new Set(current.acceptance_criteria)
      for (let priorIndex = sourceRecord.index + 1; priorIndex < publisherRecord.index; priorIndex++) {
        const prior = attempts[priorIndex]!
        if (prior.task_id !== source.task_id) continue
        const priorStart = starts.get(prior.turn_id)
        if (!priorStart || priorStart.kind !== 'turn_started') fail()
        let additive = false
        try { additive = isAcceptanceAddition(priorStart.task) } catch { fail() }
        if (!additive) continue
        const meaning = inferTaskAcceptance(priorStart.task)
        if (meaning.unresolved) fail()
        const added = meaning.criteria.filter(item => !descriptions.has(item.description))
        if (added.length) group.pendingMigrations.push(prior.attempt_id)
        for (const item of added) descriptions.add(item.description)
      }
    } else {
      let authorized = false
      try { authorized = isAcceptanceAddition(started.task) } catch { fail() }
      if (!authorized) fail()
      if (descriptor.kind === 'add') {
        if (source.attempt_id !== publisher.attempt_id || group.pendingMigrations.length) fail()
      } else if (!group.initialized || sourceRecord.index >= publisherRecord.index || sourceRecord.index <= group.lastSourceIndex ||
        group.pendingMigrations.shift() !== source.attempt_id) fail()
    }
    const meaning = inferTaskAcceptance(started.task)
    const prior = new Set(descriptor.kind === 'initialize' ? [] : previous.acceptance_criteria)
    const added = meaning.criteria.filter(item => !prior.has(item.description))
    const ids = new Set(added.map(item => item.id))
    if (meaning.unresolved || sha256Canonical(added) !== sha256Canonical(descriptor.added_acceptance) ||
      sha256Canonical(meaning.sources.filter(source => ids.has(source.criterion_id))) !== sha256Canonical(descriptor.meaning_sources)) fail()
    if (meaning.provenance.filter(record => added.some(item => record.ref.endsWith(`:${item.id}`)))
      .some(record => !current.provenance.records.some(actual => actual.kind === record.kind && actual.ref === record.ref))) fail()
    group.lastIndex = index
    group.lastSeq = event.seq
    group.lastContract = current.contract_id
    group.lastSourceIndex = sourceRecord.index
    lastAmendmentSeq = event.seq
  }
  finishGroup()
}
