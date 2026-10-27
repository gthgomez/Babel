import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { GateToolLogEntry, CompletionVerificationContext } from './completionGatePolicy.js'
import type { ChatTaskClass } from '../config/chatTaskClass.js'

/** Retained file delivery only: these observations never certify task fulfillment. */
export function unverifiedFileDeliveryPaths(input: {
  projectRoot: string
  taskClass: ChatTaskClass
  verification: CompletionVerificationContext
  shellUnavailable: boolean
  verifierEvidencePresent: boolean
  verifierTampered: boolean
  toolCallLog: readonly GateToolLogEntry[]
}): string[] | null {
  if (input.taskClass !== 'default' || !input.shellUnavailable || input.verifierTampered ||
      input.verifierEvidencePresent || input.verification.resolvedPolicy !== 'required' ||
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
    if (!['write_file', 'apply_patch'].includes(entry.tool) || entry.error || entry.exit_code !== 0 ||
        !entry.mutation_paths?.length) return null
    for (const path of entry.mutation_paths) {
      const normalized = normalize(path)
      if (!normalized) return null
      mutations.set(normalized, index)
    }
  }
  if (!mutations.size) return null
  for (const [path, index] of mutations) {
    if (!input.toolCallLog.slice(index + 1).some(entry => entry.tool === 'read_file' &&
      !entry.error && entry.exit_code === 0 && normalize(entry.target) === path)) return null
  }
  return [...mutations.keys()].sort()
}
