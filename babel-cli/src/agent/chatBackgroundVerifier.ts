import type { BackgroundShellJob, AwaitBackgroundShellResult } from './backgroundShell.js'
import type { ChatEngineActionExecutorHost } from './chatEngineContracts.js'
import { requireProjectRoot } from './chatExecutionScope.js'
import { isAuthoritativeVerifierCommand } from './completionGatePolicy.js'
import { resolveVerifierCacheIdentity } from './chatEngineVerifierAdapter.js'
import { settleChatVerifierResult } from './chatVerifierSettlement.js'
import { invalidateChatPathReads, invalidateVerifierLedger } from './chatEngineSupport.js'
import { discoverVerifierInputClosure, RevisionManager, compareRevisions, type WorkspaceRevision } from '../evidence/revisionBoundReceipt.js'
import type { PolicyGatedExecutionResult } from './toolExecutor.js'

interface BackgroundDispatch {
  engineRunId: string
  generation: number
  taskOwnerId: string | undefined
  acceptedTaskId: string | undefined
  writeCount: number
  command: string
  toolCallId: string
  identity: ReturnType<typeof resolveVerifierCacheIdentity>
  candidate: WorkspaceRevision | null
  signal: AbortSignal | undefined
  owner: ReturnType<ChatEngineActionExecutorHost['currentVerifierOwner']>
  settled: boolean
}

// Weak ownership: clearing the job registry also releases its dispatch evidence.
// Public job reads are snapshots; the completion promise is the stable process identity.
const dispatches = new WeakMap<Promise<void>, BackgroundDispatch>()
const policyCompletions = new WeakMap<Promise<void>, Promise<PolicyGatedExecutionResult>>()

/** Bind the process to its complete governed execution, including postconditions. */
export function bindChatBackgroundPolicy(job: BackgroundShellJob, completion: Promise<PolicyGatedExecutionResult>): void {
  policyCompletions.set(job.done, completion)
}

/** Output and receipts stay with the task that actually spawned the job. */
export function isChatBackgroundOwnerCurrent(host: ChatEngineActionExecutorHost, job: BackgroundShellJob, generation: number): boolean {
  const dispatch = dispatches.get(job.done)
  return host.isSubmissionCurrent(generation) && job.ownerId === host.engineRunId &&
    (dispatch === undefined || (dispatch.signal?.aborted !== true && dispatch.generation === generation &&
      dispatch.engineRunId === host.engineRunId &&
      dispatch.taskOwnerId === host.taskAllowance?.taskOwnerId &&
      dispatch.acceptedTaskId === host.taskAllowance?.acceptedTaskId))
}

function candidateRevision(projectRoot: string): WorkspaceRevision | null {
  try {
    let closure = discoverVerifierInputClosure(projectRoot)
    // Match foreground receipt capture: larger input sets require a fresh,
    // non-reusable closure rather than silently losing all verifier evidence.
    if (closure.mode === 'unsupported' && closure.reason === 'Input closure exceeds the file cap') {
      closure = discoverVerifierInputClosure(projectRoot, true)
    }
    if (closure.mode !== 'bound' || closure.paths.length === 0) return null
    return RevisionManager.computeRevisionSync(projectRoot, closure.paths)
  } catch { return null }
}

/** Capture execution provenance immediately before spawning, never when awaiting. */
export function prepareChatBackgroundDispatch(
  host: ChatEngineActionExecutorHost,
  command: string,
  cwd: string | undefined,
  generation: number,
  toolCallId: string,
  signal?: AbortSignal,
): (job: BackgroundShellJob) => void {
  const projectRoot = requireProjectRoot(host.options)
  const dispatch: BackgroundDispatch = {
    engineRunId: host.engineRunId,
    owner: host.currentVerifierOwner(),
    generation,
    taskOwnerId: host.taskAllowance?.taskOwnerId,
    acceptedTaskId: host.taskAllowance?.acceptedTaskId,
    writeCount: host.writeCount,
    command,
    toolCallId,
    identity: resolveVerifierCacheIdentity({ projectRoot, command, ...(cwd !== undefined ? { cwd } : {}) }),
    candidate: isAuthoritativeVerifierCommand(command) ? candidateRevision(projectRoot) : null,
    signal,
    settled: false,
  }
  // A running shell can change the tree before it is awaited. Old evidence and
  // retained reads cannot stay authoritative during that unknown effect.
  invalidateVerifierLedger(host, 'background command started')
  host.invalidateRepositoryContext([], 'background command started')
  invalidateChatPathReads(host, [])
  return job => dispatches.set(job.done, dispatch)
}

/** A completed process enters the same receipt/repair path exactly once. */
export async function settleChatBackgroundVerifier(input: {
  host: ChatEngineActionExecutorHost
  job: BackgroundShellJob | undefined
  result: AwaitBackgroundShellResult
  generation: number
  index: number
}): Promise<{ notes: string[]; policyRejected?: boolean }> {
  const { host, job, result, generation } = input
  const dispatch = job && dispatches.get(job.done)
  const ownsDispatch = () => dispatch !== undefined && job !== undefined &&
    isChatBackgroundOwnerCurrent(host, job, generation)
  if (!dispatch || !job || !ownsDispatch() || result.timed_out ||
    result.exit_code === null || !['completed', 'failed'].includes(result.status) || job.error) return { notes: [] }
  const completion = policyCompletions.get(job.done)
  if (!completion) return { notes: ['### verifier_receipt_unavailable\nBackground execution has no governed completion.'], policyRejected: true }
  let governed: PolicyGatedExecutionResult
  try { governed = await completion } catch {
    return { notes: ownsDispatch() ? ['### verifier_receipt_unavailable\nGoverned background execution did not settle successfully.'] : [], policyRejected: true }
  }
  if (!ownsDispatch()) return { notes: [] }
  if (governed.policyBlocked || governed.results.some(r => r.denial !== undefined || r.simulated === true)) {
    return { notes: ['### background_execution_denied', ...governed.results.map(r => r.stderr)], policyRejected: true }
  }
  if (dispatch.settled) return { notes: [] }
  dispatch.settled = true
  const projectRoot = requireProjectRoot(host.options)
  const notes: string[] = []
  const candidateIsCurrent = () => {
    if (!ownsDispatch() || !dispatch.candidate || dispatch.writeCount !== host.writeCount) return false
    const identity = resolveVerifierCacheIdentity({ projectRoot, command: dispatch.command, cwd: job.cwd })
    if (identity.key !== dispatch.identity.key) return false
    const current = candidateRevision(projectRoot)
    return current !== null && !compareRevisions(dispatch.candidate, current).stale
  }
  await settleChatVerifierResult({
    host,
    action: { type: 'run_command', command: dispatch.command, cwd: job.cwd },
    result: { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, process_started: job.processStarted === true },
    target: dispatch.command,
    tool: 'run_command',
    meta: { index: input.index, idempotencyKey: dispatch.toolCallId },
    ownerGeneration: generation,
    confirmedShellMutation: false,
    obsParts: notes,
    cacheIdentity: dispatch.identity,
    verifierOwner: dispatch.owner,
    canPublish: candidateIsCurrent,
    isOwnerCurrent: ownsDispatch,
  })
  if (!ownsDispatch()) return { notes: [] }
  if (isAuthoritativeVerifierCommand(dispatch.command) && !candidateIsCurrent()) {
    notes.push('### verifier_receipt_unavailable\nBackground verification could not bind the unchanged dispatch candidate. Run the verifier again against the current files.')
  }
  host.invalidateRepositoryContext([], 'background command settled')
  invalidateChatPathReads(host, [])
  return { notes }
}
