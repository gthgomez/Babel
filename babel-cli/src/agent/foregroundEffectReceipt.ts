import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { getTrustedHostShellInvocation } from '../sandbox.js'
import type { PolicyGatedExecutionResult } from './toolExecutor.js'
import type { TaskContractV1 } from './taskContract.js'
import type { TaskModeHistoryV2 } from './taskAcceptanceRevision.js'
import type { SessionEvent, SessionEventLog } from './sessionEvents.js'
import { isCredentialTargetPath } from './autonomyEnforcement.js'
import { frozenExactForegroundCommands, type RequestedForegroundEffect } from './requestedLocalExecution.js'
import { formatArgvAsCommand, parseSingleProcessArgv } from '../utils/commandArgv.js'
import { captureWorkspaceRevisionIdentity } from './capabilityBroker.js'
import { checkedFileBytes } from '../utils/checkedFileRead.js'

const SHA256 = /^[a-f0-9]{64}$/
const MAX_BYTES = 16 * 1024 * 1024

/** Complete host facts; the action policy remains the only dispatch authority. */
export interface ForegroundEffectReceipt {
  contract_hash: string
  task_id: string
  criterion_id: string
  command_digest: string
  argv: string[]
  cwd: '.'
  operation_id: string
  policy_decision_id: string
  input_hashes: Record<string, string>
  output?: { path: string; before: string | null; after: string; source?: 'child_stdout' }
  pre_revision: string
  post_revision: string
  stdout_digest: string
}

interface FileSnapshot {
  path: string
  digest: string | null
}

function snapshotFile(root: string, file: string): FileSnapshot | undefined {
  const absolute = resolve(root, file)
  const path = relative(root, absolute).replaceAll('\\', '/')
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || isCredentialTargetPath(path)) return
  try {
    const stat = lstatSync(absolute)
    const bytes = checkedFileBytes(absolute, MAX_BYTES, () => relative(absolute, realpathSync.native(absolute)) === '', stat)
    if (bytes !== null) return { path, digest: createHash('sha256').update(bytes).digest('hex') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    try {
      const parent = resolve(absolute, '..')
      if (relative(parent, realpathSync.native(parent)) === '') return { path, digest: null }
    } catch { /* An unproved parent cannot establish a before-image. */ }
  }
}

type PreparedEffect = { inputs: Record<string, string>; output?: FileSnapshot }

/** The existing input hashes and absent destination still hold before publication. */
export function canPublishForegroundOutput(root: string, prepared?: PreparedEffect): boolean {
  return prepared?.output?.digest === null && snapshotFile(root, prepared.output.path)?.digest === null &&
    Object.entries(prepared.inputs).every(([path, digest]) => snapshotFile(root, path)?.digest === digest)
}

/** Capture declared file bytes immediately before an already-authorized dispatch. */
export function prepareForegroundEffect(root: string, effect: RequestedForegroundEffect): PreparedEffect | undefined {
  root = realpathSync.native(root)
  const inputs: Record<string, string> = Object.create(null)
  for (const path of effect.inputPaths) {
    const input = snapshotFile(root, path)
    if (!input?.digest) return
    inputs[input.path] = input.digest
  }
  const output = effect.outputPath ? snapshotFile(root, effect.outputPath) : undefined
  if (effect.outputPath && !output) return
  return { inputs, ...(output ? { output } : {}) }
}

/** Use the governed effect transaction and physically settled executor result. */
export function settleForegroundEffect(input: {
  root: string
  command: string
  contract: TaskContractV1
  effect: RequestedForegroundEffect
  prepared: PreparedEffect
  result: PolicyGatedExecutionResult
  toolCallId: string
}): ForegroundEffectReceipt | undefined {
  const { effect, prepared, result } = input
  const root = realpathSync.native(input.root)
  const tx = result.effectTransaction
  const actual = result.results.length === 1 ? result.results[0] : undefined
  const invocation = actual && getTrustedHostShellInvocation(actual)
  const argv = parseSingleProcessArgv(input.command)
  const before = tx?.pre_revision
  const after = tx?.post_revision
  if (result.policyBlocked || result.preDispatchNoEffect || result.notStarted || !actual ||
      actual.process_started !== true || actual.process_termination !== 'exited' || actual.exit_code !== 0 ||
      actual.launch_failure !== undefined || actual.denial !== undefined || actual.simulated === true ||
      !invocation || relative(root, invocation.cwd) !== '' ||
      !tx?.shell_side || tx.status !== 'commit' || tx.task_id !== input.contract.contract_id ||
      tx.idempotency_key !== input.toolCallId || !tx.policy_decision_id || !argv ||
      sha256Canonical(argv) !== sha256Canonical(effect.argv) ||
      sha256Canonical(invocation.argv) !== sha256Canonical(effect.argv) ||
      !before || !('snapshotComplete' in before) || before.snapshotComplete !== true ||
      !after || !('snapshotComplete' in after) || after.snapshotComplete !== true) return
  if (Object.entries(prepared.inputs).some(([path, hash]) => snapshotFile(root, path)?.digest !== hash)) return
  const output = prepared.output && snapshotFile(root, prepared.output.path)
  if (prepared.output && (!output?.digest || output.digest === prepared.output.digest)) return
  const captured = invocation.capturedOutput
  const source = captured && output && prepared.output?.digest === null &&
    captured.path === output.path && captured.digest === output.digest ? 'child_stdout' : undefined
  return {
    contract_hash: input.contract.contract_hash, task_id: input.contract.task_id, criterion_id: effect.criterionId,
    command_digest: sha256Canonical(argv), argv: [...effect.argv], cwd: '.',
    operation_id: tx.transaction_id, policy_decision_id: tx.policy_decision_id, input_hashes: prepared.inputs,
    ...(prepared.output && output?.digest ? { output: { path: output.path, before: prepared.output.digest, after: output.digest,
      ...(source ? { source } : {}) } } : {}),
    pre_revision: before.compositeTreeHash, post_revision: after.compositeTreeHash,
    stdout_digest: createHash('sha256').update(actual.stdout).digest('hex'),
  }
}

/** Select only current, exact, single physical settlements backed by the same effect ledger. */
export function currentForegroundEffects(
  root: string, contract: TaskContractV1, log: SessionEventLog,
  ledger: readonly import('../executor/effectLedger.js').EffectLedgerRecord[],
  history?: TaskModeHistoryV2,
  amendments?: readonly string[],
): ForegroundEffectReceipt[] {
  root = realpathSync.native(root)
  const accepted = new Map<string, ForegroundEffectReceipt>()
  const attempted = new Set<string>()
  const currentRevision = captureWorkspaceRevisionIdentity(root)
  if (currentRevision.snapshotComplete !== true) return []
  const effects = frozenExactForegroundCommands(contract, amendments)
  const contracts = new Map([[contract.contract_hash, contract]])
  // The engine supplies its validated authority history. Only an unbroken
  // sequence of additive acceptance edges can retain a prior effect.
  if (history?.revisions.at(-1)?.contract_id === contract.contract_id) {
    for (let i = history.edges.length - 1; i >= 0; i--) {
      const { kind, from_contract_id, to_contract_id } = history.edges[i]!
      const previous = history.revisions[i]
      const following = history.revisions[i + 1]
      if (kind !== 'acceptance' || previous?.task_id !== contract.task_id ||
          previous.contract_id !== from_contract_id || following?.contract_id !== to_contract_id) break
      contracts.set(previous.contract_hash, previous)
    }
  }
  const currentTurns = new Map(log.events.flatMap(row =>
    row.kind === 'user_submitted' && row.session_id === log.session_id && row.task_id === contract.task_id
      ? [[row.turn_id, row] as const] : []))
  for (const event of log.events) {
    if (event.kind !== 'tool_completed' || event.exit_code !== 0 || event.preDispatchNoEffect ||
        !event.foreground_effect || event.session_id !== log.session_id || !event.turn_id ||
        event.tool_name !== 'run_command') continue
    const receipt = event.foreground_effect
    const submission = currentTurns.get(event.turn_id)
    const source = submission?.contract_hash && contracts.get(submission.contract_hash)
    if (!source || receipt.contract_hash !== source.contract_hash || receipt.task_id !== contract.task_id ||
        receipt.cwd !== '.' || !receipt.policy_decision_id || !SHA256.test(receipt.stdout_digest) ||
        !Array.isArray(receipt.argv) || receipt.argv.length === 0 || !receipt.argv.every(arg => typeof arg === 'string')) continue
    const command = formatArgvAsCommand(receipt.argv)
    const effect = effects.get(command)
    if (!effect || effect.criterionId !== receipt.criterion_id || event.command_digest !== receipt.command_digest ||
        receipt.command_digest !== sha256Canonical(effect.argv)) continue
    if (source !== contract &&
        sha256Canonical(source.acceptance.find(item => item.id === receipt.criterion_id) ?? null) !==
        sha256Canonical(contract.acceptance.find(item => item.id === receipt.criterion_id) ?? null)) continue
    const starts = log.events.filter(row => row.kind === 'tool_started' && currentTurns.has(row.turn_id) &&
      row.foreground_criterion_id === receipt.criterion_id && !foregroundAttemptCleared(log, row, event.seq))
    const start = starts[0]
    const receiptRecords = ledger.filter(row => row.mutationBatchId === receipt.operation_id)
    const [intent, completed] = receiptRecords
    if (starts.length !== 1 || start?.kind !== 'tool_started' || start.turn_id !== event.turn_id ||
        start.session_id !== event.session_id || start.tool_call_id !== event.tool_call_id ||
        start.tool_name !== event.tool_name || start.idempotency_key !== event.idempotency_key ||
        (submission?.seq ?? Infinity) >= start.seq || start.seq >= event.seq ||
        start.command_digest !== receipt.command_digest ||
        receiptRecords.length !== 2 || intent?.status !== 'intent' || completed?.status !== 'completed' ||
        intent.operationId !== completed.operationId || intent.sessionId !== log.session_id ||
        intent.turnId !== event.turn_id || intent.toolCallId !== event.tool_call_id ||
        completed.sessionId !== log.session_id || completed.toolName !== event.tool_name ||
        intent.preImageHashes['workspace'] !== receipt.pre_revision ||
        completed.postImageHashes?.['workspace'] !== receipt.post_revision) continue
    if (attempted.has(receipt.criterion_id)) {
      accepted.delete(receipt.criterion_id)
      continue
    }
    attempted.add(receipt.criterion_id)
    if (!receipt.input_hashes || typeof receipt.input_hashes !== 'object' ||
        Object.keys(receipt.input_hashes).length !== effect.inputPaths.length ||
        effect.inputPaths.some(path => {
          const file = snapshotFile(root, path)
          return !file?.digest || receipt.input_hashes[file.path] !== file.digest
        })) continue
    if (effect.outputPath) {
      const output = snapshotFile(root, effect.outputPath)
      if (!output?.digest || !receipt.output || output.path !== receipt.output.path ||
          output.digest !== receipt.output.after || receipt.output.before === receipt.output.after) continue
      if (receipt.output.source === 'child_stdout' && (receipt.output.before !== null ||
          completed.postImageHashes?.[`output:${output.path}`] !== receipt.output.after)) continue
    } else if (receipt.output) continue
    accepted.set(receipt.criterion_id, receipt)
  }
  // A settled later foreground effect may own the intervening revision
  // change, but an unrelated edit may not replace that evidence.
  const current: ForegroundEffectReceipt[] = []
  let revision = currentRevision.compositeTreeHash
  for (const receipt of [...accepted.values()].reverse()) {
    if (receipt.post_revision !== revision) break
    current.unshift(receipt)
    revision = receipt.pre_revision
  }
  return current
}

/** Another model proposal is not authority to repeat a non-idempotent effect. */
export function foregroundStarted(log: SessionEventLog, taskId: string, criterionId: string): boolean {
  const turns = new Set(log.events.flatMap(event =>
    event.kind === 'user_submitted' && event.task_id === taskId ? [event.turn_id] : []))
  return log.events.some(event => event.kind === 'tool_started' && turns.has(event.turn_id) &&
    event.foreground_criterion_id === criterionId && !foregroundAttemptCleared(log, event))
}

function foregroundAttemptCleared(
  log: SessionEventLog, start: Extract<SessionEvent, {kind: 'tool_started'}>, beforeSeq = Infinity,
): boolean {
  const terminal = log.events.find(event =>
    (event.kind === 'tool_failed' || event.kind === 'tool_cancelled') && event.session_id === start.session_id &&
    event.turn_id === start.turn_id && event.tool_call_id === start.tool_call_id &&
    event.idempotency_key === start.idempotency_key && event.tool_name === start.tool_name &&
    event.seq > start.seq && event.seq < beforeSeq)
  if (terminal?.kind !== 'tool_failed' && terminal?.kind !== 'tool_cancelled') return false
  if (terminal.preDispatchNoEffect === true) return true
  return terminal.kind === 'tool_cancelled' && terminal.recovery_state === 'TOOL_OUTCOME_UNKNOWN' &&
    !!terminal.args_digest && log.events.some(event =>
      event.kind === 'recovery_reconciled' && event.session_id === start.session_id &&
      event.recovered_idempotency_key === start.idempotency_key && event.operation_fingerprint === terminal.args_digest &&
      event.seq > terminal.seq && event.seq < beforeSeq)
}
