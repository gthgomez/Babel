import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { GateToolLogEntry, CompletionVerificationContext } from './completionGatePolicy.js'
import type { ChatTaskClass } from '../config/chatTaskClass.js'
import { isAuthoritativeVerifierCommand } from './completionGatePolicy.js'

/** Retained file delivery only: these observations never certify task fulfillment. */
export function unverifiedFileDeliveryPaths(input: {
  projectRoot: string
  taskClass: ChatTaskClass
  verification: CompletionVerificationContext
  shellUnavailable: boolean
  /** True only after the required-verifier recovery policy has exhausted its retries. */
  allowAfterExhaustion?: boolean
  verifierEvidencePresent: boolean
  verifierTampered: boolean
  toolCallLog: readonly GateToolLogEntry[]
}): string[] | null {
  if (!['default', 'general_swe'].includes(input.taskClass) ||
      (!input.shellUnavailable && input.allowAfterExhaustion !== true) || input.verifierTampered ||
      (input.verifierEvidencePresent && input.allowAfterExhaustion !== true) || input.verification.resolvedPolicy !== 'required' ||
      input.verification.mandatoryVerifierContract) return null
  const normalize = (path: string): string | null => {
    if (!path.trim()) return null
    const rel = relative(resolve(input.projectRoot), resolve(input.projectRoot, path))
    return !rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ? null : rel
  }
  const mutations = new Map<string, number>()
  for (const [index, entry] of input.toolCallLog.entries()) {
    if (entry.effect_status === 'indeterminate') return null
    if (entry.effect_status !== 'confirmed_change') continue
    if (!['write_file', 'str_replace', 'apply_patch'].includes(entry.tool) || entry.error || entry.exit_code !== 0 ||
        !entry.mutation_paths?.length) return null
    for (const path of entry.mutation_paths) {
      const normalized = normalize(path)
      if (!normalized) return null
      mutations.set(normalized, index)
    }
  }
  if (!mutations.size) return null
  for (const [path, index] of mutations) {
    if (!input.toolCallLog.slice(index + 1).some(entry => ['read_file', 'read_range'].includes(entry.tool) &&
      !entry.error && entry.exit_code === 0 && normalize(entry.target) === path)) return null
  }
  return [...mutations.keys()].sort()
}

/** Explain verification state from host execution records without echoing command output. */
export function describeUnverifiedVerifierStatus(toolCallLog: readonly GateToolLogEntry[]): string {
  const attempts = toolCallLog.filter(entry =>
    (entry.tool === 'run_command' || entry.tool === 'test_run') && isAuthoritativeVerifierCommand(entry.target))
  const executed = attempts.filter(entry => entry.verifierExecuted === true && entry.preDispatchNoEffect !== true)
  const denied = attempts.filter(entry => entry.preDispatchNoEffect === true)
  const last = executed.at(-1)
  if (last) {
    if (last.exit_code !== undefined && last.exit_code !== 0) {
      return `A verifier process started and exited with status ${last.exit_code}; no passing current verifier result was accepted.`
    }
    return 'A verifier process started, but the host did not accept a current passing verifier result.'
  }
  if (denied.length > 0) {
    return 'The verifier command was denied before dispatch. It did not run and provides no test result.'
  }
  return 'No authoritative verifier execution is recorded. Task fulfillment is not certified.'
}
