import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '../acceptance/canonical.js'
import { deepFreeze } from '../acceptance/freeze.js'
import {
  buildTaskContractV1, freezeTaskContract, validateTaskContractV1,
  type TaskContractV1, type AcceptanceRequirementV1,
} from './taskContract.js'
import { ACCEPTANCE_MEANING_REF, inferTaskAcceptance, type AcceptanceMeaningSource } from './taskAcceptanceMeaning.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { isAmendmentPrompt, isStatusPrompt } from './turnRuntime.js'

export const ACCEPTANCE_AMENDMENT_REF = `user:task-${'acceptance-amendment:v1'}` as const
export interface TaskAcceptanceDescriptorV1 {
  schema_version: 1
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
  const meaning = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(source.userInput),
    trustedVerifierCommands: current.verifier_requirements,
    defaultWorkingDirectory: '.',
  })
  if (meaning.unresolved)
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: State the additional observable requirement explicitly')
  const previousDescriptions = new Set(kind === 'initialize' ? [] : current.acceptance_criteria)
  const added = meaning.criteria.filter(item => !previousDescriptions.has(item.description))
  if (!added.length) return null
  if (added.some(item => /^(?:skip|remove|drop|ignore|waive|replace|stop requiring|no longer)\b/i.test(item.description)))
    throw new Error('TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED: An additive amendment cannot remove required obligations')
  const ids = new Set(added.map(item => item.id))
  const descriptor: TaskAcceptanceDescriptorV1 = deepFreeze({
    schema_version: 1, kind, amendment_id: randomUUID(),
    task_id: current.task_id, previous_contract_id: current.contract_id,
    previous_contract_hash: current.contract_hash, source_attempt_id: source.attemptId,
    input_digest: source.inputDigest, text_digest: sha256Canonical(source.userInput),
    added_acceptance: structuredClone(added),
    meaning_sources: meaning.sources.filter(item => ids.has(item.criterion_id)),
  })
  const acceptance = [...(kind === 'initialize' ? [] : current.acceptance), ...added]
  const contract = freezeTaskContract(buildTaskContractV1({
    ...current, acceptance, acceptance_criteria: acceptance.map(item => item.description),
    provenance: [
      ...current.provenance.records,
      ...meaning.provenance.filter(record => added.some(item => record.ref.endsWith(`:${item.id}`))),
      { kind: 'explicit_user_authority', ref: `${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(descriptor)}` },
    ],
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
  const description = 'Task acceptance criteria as stated in the user request'
  const placeholder: AcceptanceRequirementV1 = {
    id: 'acceptance:1', description, type: 'custom', required: true,
    verification_strategy: 'independent evidence bound to the candidate revision',
    verification: { kind: 'custom', verifier_id: 'verifier:custom:1', command_hash: sha256Canonical(description) },
  }
  return sha256Canonical(contract.acceptance) === sha256Canonical([placeholder]) &&
    sha256Canonical(contract.acceptance_criteria) === sha256Canonical([description]) &&
    !contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:'))
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
  return Object.keys(descriptor).length===fields.length&&fields.every(field=>Object.hasOwn(descriptor,field))&&
    descriptor.schema_version===1&&['add','initialize','migrate_addition'].includes(descriptor.kind)&&
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
  const expectedRecords = [
    { kind: 'user_goal', ref: 'user_request' },
    { kind: 'derived_acceptance', ref: 'acceptance_criteria' },
    ...previous.provenance.records,
    ...descriptor.meaning_sources.map(source => ({ kind: 'derived_acceptance',
      ref: `${ACCEPTANCE_MEANING_REF}:${source.status}:${source.input_digest}:${source.start}:${source.end}:${source.criterion_id}` })),
    { kind: 'explicit_user_authority', ref: `${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(descriptor)}` },
  ]
  if (current.provenance.source !== 'taskAcceptanceRevision' ||
    sha256Canonical(current.provenance.records) !== sha256Canonical(expectedRecords)) errors.push('provenance')
  if (!current.provenance.records.some(record => record.kind === 'explicit_user_authority' &&
    record.ref === `${ACCEPTANCE_AMENDMENT_REF}:${sha256Canonical(descriptor)}`)) errors.push('marker')
  return errors
}
