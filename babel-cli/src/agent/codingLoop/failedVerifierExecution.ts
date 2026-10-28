import { greenProof } from '../completionGatePolicy.js'
import { createHash } from 'node:crypto'
import { decodeCommand } from '../../authority/commandDecoder.js'
import type { VerifierEvidenceOwner } from '../../executor/contracts.js'
import { parseCommandArgv } from '../../utils/commandArgv.js'
import { satisfiesVerifierRequirement, verifierExecutionFingerprint } from '../../services/verifierIdentity.js'
import type { RecoveryCandidateBinding } from './workingState.js'

/** Host execution history only: never a completion receipt or edit permit. */
export interface SettledFailedVerifierExecution {
  schemaVersion: 1
  command: string
  argv: string[]
  executionFingerprint: string
  owner: VerifierEvidenceOwner
  cwd: string
  environmentFingerprint: string
  candidate: RecoveryCandidateBinding
  toolCallId: string
  order: { sessionId: string; seq: number }
  processStarted: true
  exitCode: number
  termination: 'exited'
}

export function failedVerifierContextKey(command: string, owner: VerifierEvidenceOwner, cwd: string, environmentFingerprint: string): string {
  return createHash('sha256').update(JSON.stringify([verifierExecutionFingerprint(command), parseCommandArgv(command),
    owner.workspaceRoot, owner.taskId, owner.contractHash, cwd, environmentFingerprint])).digest('hex')
}

export function validFailedVerifierExecution(value: unknown): value is SettledFailedVerifierExecution {
  if (!value || typeof value !== 'object') return false
  try {
  const d = value as SettledFailedVerifierExecution
  return d.schemaVersion === 1 && d.processStarted === true && d.termination === 'exited' &&
    Number.isSafeInteger(d.exitCode) && d.exitCode !== 0 && typeof d.command === 'string' &&
    Array.isArray(d.argv) && d.argv.every(arg => typeof arg === 'string') && JSON.stringify(d.argv) === JSON.stringify(parseCommandArgv(d.command)) &&
    !!d.owner && ['workspaceRoot', 'taskId', 'contractHash', 'sessionId'].every(key => typeof d.owner[key as keyof VerifierEvidenceOwner] === 'string' && d.owner[key as keyof VerifierEvidenceOwner].length > 0) &&
    typeof d.cwd === 'string' && d.cwd.length > 0 && typeof d.environmentFingerprint === 'string' && d.environmentFingerprint.length > 0 &&
    !!d.candidate && d.candidate.schemaVersion === 1 && ['taskId', 'contractHash', 'repositoryIdentity', 'workspaceRevision'].every(key => typeof d.candidate[key as keyof RecoveryCandidateBinding] === 'string' && String(d.candidate[key as keyof RecoveryCandidateBinding]).length > 0) &&
    d.candidate.taskId === d.owner.taskId && d.candidate.contractHash === d.owner.contractHash &&
    typeof d.toolCallId === 'string' && d.toolCallId.length > 0 && !!d.order && d.order.sessionId === d.owner.sessionId && Number.isSafeInteger(d.order.seq) && d.order.seq >= 0 &&
    d.executionFingerprint === failedVerifierContextKey(d.command, d.owner, d.cwd, d.environmentFingerprint) &&
    decodeCommand(d.command).capability === 'run_tests'
  } catch { return false }
}

export function matchesFailedVerifierReplay(descriptor: SettledFailedVerifierExecution | undefined, input: {
  command: string; owner?: VerifierEvidenceOwner | undefined; cwd: string; environmentFingerprint: string
}): boolean {
  try { return validFailedVerifierExecution(descriptor) && !!input.owner && descriptor.owner.sessionId === input.owner.sessionId &&
    decodeCommand(input.command).capability === 'run_tests' &&
    descriptor.executionFingerprint === failedVerifierContextKey(input.command, input.owner, input.cwd, input.environmentFingerprint)
  } catch { return false }
}

/** Resume/runtime replay needs the matching host start and settled event chain. */
export function attestedFailedVerifierExecution(log: import('../sessionEvents.js').SessionEventLog, descriptor: SettledFailedVerifierExecution | undefined): boolean {
  if (!validFailedVerifierExecution(descriptor) || log.session_id !== descriptor.order.sessionId) return false
  const recorded = log.events.find(event => event.seq === descriptor.order.seq && event.kind === 'verifier_attempt')
  if (recorded?.kind !== 'verifier_attempt' || recorded.tool_call_id !== descriptor.toolCallId ||
      JSON.stringify(recorded.failed_execution) !== JSON.stringify(descriptor)) return false
  const started = log.events.filter(event => event.kind === 'tool_started' && event.tool_call_id === descriptor.toolCallId && event.seq < recorded.seq)
  const terminal = log.events.filter(event => ['tool_completed', 'tool_failed', 'tool_cancelled'].includes(event.kind) &&
    'tool_call_id' in event && event.tool_call_id === descriptor.toolCallId)
  return started.length === 1 && terminal.length === 1 && terminal[0]!.kind === 'tool_failed' &&
    terminal[0]!.exit_code === descriptor.exitCode && terminal[0]!.seq > recorded.seq
}

/** Reconstruct host failures from durable facts, never from model text or a snapshot alone. */
export function restoreFailedVerifierHistory(log: import('../sessionEvents.js').SessionEventLog, owner: VerifierEvidenceOwner | undefined): {
  history: SettledFailedVerifierExecution[]; overflow: boolean
} {
  const history: SettledFailedVerifierExecution[] = []
  let overflow = false
  for (const event of log.events) {
    if (event.kind !== 'verifier_attempt' || !event.failed_execution || !owner) continue
    const descriptor = event.failed_execution
    if (!attestedFailedVerifierExecution(log, descriptor) ||
        descriptor.owner.workspaceRoot !== owner.workspaceRoot || descriptor.owner.taskId !== owner.taskId ||
        descriptor.owner.contractHash !== owner.contractHash || descriptor.owner.sessionId !== owner.sessionId) continue
    const old = history.findIndex(item => item.executionFingerprint === descriptor.executionFingerprint)
    if (old >= 0) history.splice(old, 1)
    if (history.length < 64) history.push(descriptor)
    else overflow = true
  }
  return { history, overflow }
}

/** A receipt-free failure stays unresolved until a newer covering current green. */
export function unresolvedFailedVerifierHistory(history: readonly SettledFailedVerifierExecution[], currentGreens: readonly import('../../executor/contracts.js').ExecutorVerifierReceipt[]): SettledFailedVerifierExecution[] {
  return history.filter(failed => !currentGreens.some(green => {
    const context = green.executionContext
    return greenProof(green) && green.stale === false && green.order?.sessionId === failed.owner.sessionId && green.order.seq > failed.order.seq &&
      !!context && context.workspaceRoot === failed.owner.workspaceRoot && context.taskId === failed.owner.taskId && context.contractHash === failed.owner.contractHash &&
      context.workingDirectory === failed.cwd && context.environmentFingerprint === failed.environmentFingerprint &&
      satisfiesVerifierRequirement(failed.command, green.command)
  }))
}
