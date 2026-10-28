import { discoverVerifierInputClosure, RevisionManager, compareRevisions, type WorkspaceRevision } from '../evidence/revisionBoundReceipt.js'
import { canonicalizeContained } from '../bridge/workspaceBound.js'
import type { RequiredVerifierRecord, VerifierEvidenceOwner } from '../executor/contracts.js'
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'
import { resolveVerifierCacheIdentity } from './chatEngineVerifierAdapter.js'

/** Freeze host acceptance identity independently from any verifier receipt. */
export function chatVerifierOwner(input: {
  projectRoot: string | null; sessionId: string; taskId: string; contractHash: string
}): VerifierEvidenceOwner | undefined {
  if (!input.projectRoot || ![input.sessionId, input.taskId, input.contractHash].every(value => value.length > 0)) return undefined
  try { return { workspaceRoot: canonicalizeContained(input.projectRoot), sessionId: input.sessionId, taskId: input.taskId, contractHash: input.contractHash } }
  catch { return undefined }
}

export function chatVerifierRequirements(owner: VerifierEvidenceOwner | undefined, commands: readonly string[], task: string, governedProjectRoot?: string): RequiredVerifierRecord[] {
  if (!owner) return []
  // Ownership is physical; the actual execution environment retains the host's
  // chosen root spelling. Never derive either from a receipt or recanonicalize
  // the frozen owner after an alias has been retargeted.
  const executionRoot = governedProjectRoot ?? owner.workspaceRoot
  try { if (canonicalizeContained(executionRoot) !== owner.workspaceRoot) return [] }
  catch { return [] }
  const explicitBroad = /\b(?:full[ -]suite|all (?:the )?tests|entire test suite|high[ -]assurance)\b/i.test(task)
  return commands.map(command => {
    const identity = analyzeVerifierIdentity(command)
    const context = resolveVerifierCacheIdentity({ projectRoot: executionRoot, command })
    return { command, executionContext: { workspaceRoot: owner.workspaceRoot, taskId: owner.taskId, contractHash: owner.contractHash,
      workingDirectory: context.cwd, environmentFingerprint: context.envKey, targetSelectors: identity?.targetSelectors ?? [] },
      requiredScope: explicitBroad || identity?.scope !== 'targeted' ? 'full_suite' : 'targeted', greenRequired: true }
  })
}

/** Freeze actual verifier inputs separately from the Git recovery binding. */
export function freezeChatVerifierCandidate(root: string): WorkspaceRevision | null {
  try {
    let closure = discoverVerifierInputClosure(root)
    if (closure.mode === 'unsupported' && closure.reason === 'Input closure exceeds the file cap') closure = discoverVerifierInputClosure(root, true)
    return closure.mode === 'bound' && closure.paths.length ? RevisionManager.computeRevisionSync(root, closure.paths) : null
  } catch { return null }
}

export function chatVerifierCandidateCurrent(root: string, candidate: WorkspaceRevision | null): boolean {
  const current = freezeChatVerifierCandidate(root)
  return !!candidate && !!current && !compareRevisions(candidate, current).stale
}
