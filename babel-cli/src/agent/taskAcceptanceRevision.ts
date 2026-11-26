import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '../acceptance/canonical.js'
import { deepFreeze } from '../acceptance/freeze.js'
import {
  buildTaskContractV1, freezeTaskContract, validateTaskContractV1,
  type TaskContractV1, type AcceptanceRequirementV1,
} from './taskContract.js'
import {
  acceptanceMeaningRefForVersion,
  inferTaskAcceptance,
  inferTaskAcceptanceForVersion,
  isAcceptanceMeaningDerivedRef,
  isLegacyAcceptancePlaceholderContract,
  requireAcceptanceMeaningVersion,
  type AcceptanceMeaningSource,
} from './taskAcceptanceMeaning.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { isRequestedOperationAmendmentRef, requestedLocalExecutionAcceptance, REQUESTED_LOCAL_EXECUTION_KIND } from './requestedLocalExecution.js'
import { isAmendmentPrompt, isStatusPrompt } from './turnRuntime.js'

export const ACCEPTANCE_AMENDMENT_REF = `user:task-${'acceptance-amendment:v1'}` as const
export interface TaskAcceptanceDescriptorV1 {
  /** v1 replays unbound meaning; v2 binds verifiers; v3 adds requested runtime effects. */
  schema_version: 1 | 2 | 3
  kind: 'add' | 'initialize' | 'migrate_addition'
  amendment_id: string
  task_id: string
  previous_contract_id: string
  previous_contract_hash: string
  source_attempt_id: string
  input_digest: string
  text_digest: string
  added_acceptance: AcceptanceRequirementV1[]
  meaning_sources: AcceptanceMeaningSource[]
  requested_execution_refs?: string[]
}
export type TaskRevisionEdgeV2 = {
  from_contract_id: string
  to_contract_id: string
} & ({ kind: 'mode' } | { kind: 'acceptance'; descriptor: TaskAcceptanceDescriptorV1 })
export interface TaskModeHistoryV2 {
  schema_version: 2
  revisions: TaskContractV1[]
  edges: TaskRevisionEdgeV2[]
}

/** Only complete supported status forms prove a non-amending continuation. */
function isStandaloneAcceptanceStatus(input: string): boolean {
  const meaning = inferTaskAcceptance(input)
  if (!meaning.structurallyComplete || meaning.sources.some(source => source.status !== 'unresolved')) return false
  const prose = meaning.activeProse.join(' ').replace(/\s+/g, ' ').trim()
  // A question prefix and absence of known mutation verbs cannot prove that
  // arbitrary trailing prose contains no obligation. Ambiguity stays explicit.
  return isStatusPrompt(prose) || /^what(?:'s| is) (?:the )?current status\??$/i.test(prose)
}

/** Continuity syntax alone never authorizes changing frozen acceptance. */
export function isAcceptanceAddition(input: string): boolean {
  if (!isAmendmentPrompt(input)) return false
  const directive = input.trim().replace(/^(?:also|additionally|and)\b[\s,:]*/i, '')
  if (/^(?:skip|remove|drop|ignore|waive|replace|stop requiring|no longer)\b/i.test(directive))
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: Required checks cannot be waived by ambiguous prose; identify an explicit task change instead')
  const positive = /^(?:require|preserve|ensure|support|add|include|keep|maintain|reject|prevent|display|return|allow|validate|run|test)\b/i.test(directive)
  if (!positive && isStandaloneAcceptanceStatus(directive)) return false
  if (!positive || directive.endsWith('?') && !directive.includes('\n'))
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: State the additional observable requirement explicitly')
  return true
}

/** Project an amendment from its canonical source under the predecessor's original meaning. */
export function projectTaskAcceptanceRevision(
  previous: TaskContractV1,
  userInput: string,
  kind: TaskAcceptanceDescriptorV1['kind'],
  version: TaskAcceptanceDescriptorV1['schema_version'],
): {
  added: AcceptanceRequirementV1[]
  meaningSources: AcceptanceMeaningSource[]
  operationRefs: string[]
  unresolved: boolean
} {
  const interpretationVersion = requireAcceptanceMeaningVersion(previous.provenance.records, previous)
  const inferred = inferTaskAcceptanceForVersion(userInput, interpretationVersion)
  const meaning = version === 1 ? inferred : bindExecutableVerifiersToTaskAcceptance({
    meaning: inferred,
    trustedVerifierCommands: previous.verifier_requirements,
    defaultWorkingDirectory: '.',
    existingVerifierInputFiles: previous.protected_paths,
  })
  const retained = kind === 'initialize' ? [] : previous.acceptance
  const descriptions = new Set(retained.map(item => item.description))
  const standard = meaning.criteria.filter(item => !descriptions.has(item.description))
  const requested = version === 3 ? requestedLocalExecutionAcceptance({
    request: userInput, activeProse: meaning.activeProse,
    existingCriteria: [...retained, ...standard],
    amendment: true,
  }) : undefined
  const soleSource = requested?.sources.length === 1 ? requested.sources[0] : undefined
  const soleExplicitEffect = soleSource !== undefined &&
    userInput.trim().replace(/^(?:also|additionally|and)\b[\s,:]*/i, '').replace(/[.!]$/, '') ===
      userInput.slice(soleSource.start, soleSource.end)
  const added = [...(soleExplicitEffect && meaning.unresolved ? [] : standard), ...(requested?.criteria ?? [])]
  const ids = new Set(added.map(item => item.id))
  return {
    added,
    meaningSources: [...meaning.sources, ...(requested?.sources ?? [])].filter(item => ids.has(item.criterion_id)),
    operationRefs: requested?.criteria.length ? requested.provenance.map(record => record.ref) : [],
    unresolved: meaning.unresolved && !soleExplicitEffect,
  }
}

function revisionProvenance(
  previous: TaskContractV1,
  descriptor: TaskAcceptanceDescriptorV1,
): TaskContractV1['provenance']['records'] {
  const meaningRef = acceptanceMeaningRefForVersion(requireAcceptanceMeaningVersion(previous.provenance.records, previous))
  return [
    ...previous.provenance.records,
    ...descriptor.meaning_sources.map(source => ({ kind: 'derived_acceptance' as const,
      ref: `${meaningRef}:${source.status}:${source.input_digest}:${source.start}:${source.end}:${source.criterion_id}` })),
    ...(descriptor.requested_execution_refs ?? []).map(ref => ({ kind: 'derived_acceptance' as const, ref })),
    { kind: 'explicit_user_authority', ref: `${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(descriptor)}` },
  ]
}

/** Build the descriptor before the resulting hash, avoiding circular provenance. */
export function createTaskAcceptanceRevision(
  current: TaskContractV1,
  source: { userInput: string; inputDigest: string; attemptId: string },
  kind: TaskAcceptanceDescriptorV1['kind'] = 'add',
): { contract: TaskContractV1; descriptor: TaskAcceptanceDescriptorV1 } | null {
  if (kind === 'initialize') {
    if (!isLegacyAcceptancePlaceholder(current) || source.userInput !== current.user_request)
      throw new Error('TASK_ACCEPTANCE_INITIALIZATION_UNAVAILABLE')
  } else if (!isAcceptanceAddition(source.userInput)) return null
  // Only a new user addition can admit a new runtime obligation. Legacy
  // initialization and migration still use their historical V2 semantics.
  const { added, meaningSources, operationRefs, unresolved } =
    projectTaskAcceptanceRevision(current, source.userInput, kind, kind === 'add' ? 3 : 2)
  if (unresolved)
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: State the additional observable requirement explicitly')
  if (!added.length) return null
  if (added.some(item => /^(?:skip|remove|drop|ignore|waive|replace|stop requiring|no longer)\b/i.test(item.description)))
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: An additive amendment cannot remove required obligations')
  const descriptor: TaskAcceptanceDescriptorV1 = deepFreeze({
    schema_version: operationRefs.length ? 3 : 2, kind, amendment_id: randomUUID(),
    task_id: current.task_id, previous_contract_id: current.contract_id,
    previous_contract_hash: current.contract_hash, source_attempt_id: source.attemptId,
    input_digest: source.inputDigest, text_digest: sha256Canonical(source.userInput),
    added_acceptance: structuredClone(added),
    meaning_sources: meaningSources,
    ...(operationRefs.length ? { requested_execution_refs: operationRefs } : {}),
  })
  const acceptance = [...(kind === 'initialize' ? [] : current.acceptance), ...added]
  const contract = freezeTaskContract(buildTaskContractV1({
    ...current, acceptance, acceptance_criteria: acceptance.map(item => item.description),
    provenance: revisionProvenance(current, descriptor),
    source: 'taskAcceptanceRevision', parent_contract_id: current.contract_id,
    failure_class_budgets: current.budgets.failure_class_budgets,
    ...(current.budgets.max_turns !== undefined ? { max_turns: current.budgets.max_turns } : {}),
    ...(current.budgets.max_tokens !== undefined ? { max_tokens: current.budgets.max_tokens } : {}),
  }))
  if (validateTaskAcceptanceRevision(current, contract, descriptor).length)
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_INVALID')
  return { contract, descriptor }
}

/** Recognize only the exact historical generated placeholder, never a real check. */
export function isLegacyAcceptancePlaceholder(contract: TaskContractV1): boolean {
  return isLegacyAcceptancePlaceholderContract(contract)
}

function stableAuthority(contract: TaskContractV1): string {
  const { contract_id: _id, contract_hash: _hash, created_at: _time, frozen: _frozen,
    provenance: _provenance, acceptance: _acceptance, acceptance_criteria: _criteria, ...rest } = contract
  return sha256Canonical(rest)
}

/** Structural edge validation; canonical source validation belongs to the lifecycle. */
export function isTaskAcceptanceDescriptor(value:unknown):value is TaskAcceptanceDescriptorV1{
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor=value as TaskAcceptanceDescriptorV1
  const fields = ['schema_version', 'kind', 'amendment_id', 'task_id', 'previous_contract_id',
    'previous_contract_hash', 'source_attempt_id', 'input_digest', 'text_digest', 'added_acceptance', 'meaning_sources']
  if (descriptor.schema_version === 3) fields.push('requested_execution_refs')
  const validOperationRefs = descriptor.schema_version !== 3 || (
    descriptor.kind === 'add' && Array.isArray(descriptor.added_acceptance) &&
    descriptor.added_acceptance.some(item => item?.verification?.kind === REQUESTED_LOCAL_EXECUTION_KIND) &&
    Array.isArray(descriptor.requested_execution_refs) && descriptor.requested_execution_refs.length > 0 &&
    descriptor.requested_execution_refs.length <= 384 &&
    descriptor.requested_execution_refs.every(ref => typeof ref === 'string' && isRequestedOperationAmendmentRef(ref))
  )
  return Object.keys(descriptor).length===fields.length&&fields.every(field=>Object.hasOwn(descriptor,field))&&
    validOperationRefs && (descriptor.schema_version===1||descriptor.schema_version===2||descriptor.schema_version===3)&&['add','initialize','migrate_addition'].includes(descriptor.kind)&&
    [descriptor.amendment_id,descriptor.task_id,descriptor.previous_contract_id,descriptor.source_attempt_id].every(field=>typeof field==='string'&&field.length>0&&field.length<=512)&&
    /^[0-9a-f]{32,64}$/.test(descriptor.previous_contract_hash)&&/^[0-9a-f]{64}$/.test(descriptor.input_digest)&&/^[0-9a-f]{64}$/.test(descriptor.text_digest)&&
    Array.isArray(descriptor.added_acceptance)&&descriptor.added_acceptance.length>0&&descriptor.added_acceptance.length<=128&&
    Array.isArray(descriptor.meaning_sources)&&descriptor.meaning_sources.length===descriptor.added_acceptance.length&&
    descriptor.added_acceptance.every(item=>item&&typeof item==='object'&&typeof item.description==='string'&&item.description.length>0&&item.description.length<=4096&&item.required===true)&&
    descriptor.meaning_sources.every(item=>item&&typeof item==='object'&&typeof item.criterion_id==='string'&&['explicit','inferred'].includes(item.status)&&item.input_digest===descriptor.text_digest&&Number.isInteger(item.start)&&item.start>=0&&Number.isInteger(item.end)&&item.end>=item.start&&item.end<=65536)
}

/** Structural edge validation; canonical source validation belongs to the lifecycle. */
export function validateTaskAcceptanceRevision(
  previous: TaskContractV1, current: TaskContractV1, value: unknown,
): string[] {
  if(!isTaskAcceptanceDescriptor(value))return ['descriptor']
  if(validateTaskContractV1(previous).length||validateTaskContractV1(current).length)return ['contract']
  const descriptor=value
  const errors: string[] = []
  if (descriptor.task_id !== previous.task_id || descriptor.previous_contract_id !== previous.contract_id ||
    descriptor.previous_contract_hash !== previous.contract_hash || current.provenance.parent_contract_id !== previous.contract_id)
    errors.push('predecessor')
  if (stableAuthority(previous) !== stableAuthority(current)) errors.push('authority')
  if (descriptor.kind === 'initialize' && !isLegacyAcceptancePlaceholder(previous)) errors.push('initialization')
  const retained = descriptor.kind === 'initialize' ? [] : previous.acceptance
  if (sha256Canonical(current.acceptance) !== sha256Canonical([...retained, ...descriptor.added_acceptance]) ||
    sha256Canonical(current.acceptance_criteria) !== sha256Canonical(current.acceptance.map(item => item.description))) errors.push('delta')
  const predecessorVersion = requireAcceptanceMeaningVersion(previous.provenance.records, previous)
  try {
    if (requireAcceptanceMeaningVersion(current.provenance.records, current) !== predecessorVersion) {
      errors.push('interpretation_version')
    }
  } catch {
    errors.push('interpretation_version')
  }
  const expectedRecords = [
    { kind: 'user_goal', ref: 'user_request' },
    { kind: 'derived_acceptance', ref: 'acceptance_criteria' },
    ...revisionProvenance(previous, descriptor),
  ]
  if (current.provenance.source !== 'taskAcceptanceRevision' ||
    sha256Canonical(current.provenance.records) !== sha256Canonical(expectedRecords)) errors.push('provenance')
  if (!current.provenance.records.some(record => record.kind === 'explicit_user_authority' &&
    record.ref === `${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(descriptor)}`)) errors.push('marker')
  return errors
}
