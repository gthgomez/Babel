/**
 * Deterministic crash/restart acceptance matrix for the executor substrate.
 *
 * The parent process runs one isolated child per fault point. The child writes
 * only durable ledger/event records, exits at the requested boundary, and the
 * parent reloads the same run directory to validate reconciliation. Output is
 * a redacted JSON report: no prompts, environment values, or tool output.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  findInterruptedEffects,
  loadEffectLedger,
  reconcileInterruptedEffect,
  recordEffectIntent,
  recordEffectTerminal,
  type EffectReconciliationDecision,
} from '../src/executor/effectLedger.js'
import type { ToolEffectClass } from '../src/executor/contracts.js'
import {
  createSessionEventLog,
  flushSessionEventLog,
  loadSessionEventLogFromDir,
  recordMutationBatch,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordVerifierAttempt,
} from '../src/agent/sessionEvents.js'

const FAULT_EXIT_CODE = 75
const EFFECT_CLASSES: readonly ToolEffectClass[] = [
  'read_only',
  'idempotent',
  'reconcilable_mutation',
  'non_idempotent_local_effect',
  'external_side_effect',
]
const FAULT_POINTS = [
  'after_intent_persist',
  'after_effect_start',
  'after_side_effect',
  'after_verifier_attempt',
  'after_mutation_revision',
  'after_terminal_persist',
] as const
type FaultPoint = (typeof FAULT_POINTS)[number]

interface FaultRow {
  effectClass: ToolEffectClass
  faultPoint: FaultPoint
  childExitCode: number | null
  interruptedCount: number
  terminalCount: number
  decision: EffectReconciliationDecision | 'not_interrupted'
  duplicateMutation: boolean
  pass: boolean
}

interface FaultReport {
  schemaVersion: 1
  matrixSize: number
  passed: number
  failed: number
  duplicateMutations: number
  rows: FaultRow[]
}

function shouldFault(point: FaultPoint): boolean {
  return process.env['BABEL_FAULT_POINT'] === point
}

function stopAt(point: FaultPoint): void {
  if (shouldFault(point)) process.exit(FAULT_EXIT_CODE)
}

function writeChildRun(runDir: string, effectClass: ToolEffectClass): void {
  const sessionId = 'fault-session'
  const turnId = 'fault-turn'
  const target = 'workspace.txt'
  const preImageHashes = { [target]: 'before' }
  const postImageHashes = { [target]: 'after' }
  const ledgerIntent = recordEffectIntent({
    runDir,
    sessionId,
    turnId,
    mutationBatchId: 'fault-batch',
    effectClass,
    toolName: effectClass === 'idempotent' ? 'test_run' : 'file_write',
    targetPaths: [target],
    preImageHashes,
    intendedContent: 'after',
  })

  const eventLog = createSessionEventLog(sessionId)
  recordToolProposed(eventLog, {
    turn_id: turnId,
    tool_call_id: 'fault-tool',
    tool_name: ledgerIntent.toolName,
    idempotency_key: ledgerIntent.operationId,
  })
  flushSessionEventLog(runDir, eventLog)
  stopAt('after_intent_persist')

  recordToolStarted(eventLog, {
    turn_id: turnId,
    tool_call_id: 'fault-tool',
    tool_name: ledgerIntent.toolName,
    idempotency_key: ledgerIntent.operationId,
  })
  flushSessionEventLog(runDir, eventLog)
  stopAt('after_effect_start')

  // The simulated side effect is represented by deterministic image hashes;
  // no real workspace or external process is touched by this harness.
  stopAt('after_side_effect')

  recordVerifierAttempt(eventLog, {
    turn_id: turnId,
    command_preview: 'pytest tests/fixture.py',
    authoritative: effectClass === 'idempotent',
    exit_code: 0,
  })
  flushSessionEventLog(runDir, eventLog)
  stopAt('after_verifier_attempt')

  recordMutationBatch(eventLog, turnId, {
    paths: [target],
    starting_revision: 'before',
    ending_revision: 'after',
    changed_bytes: 5,
    batch_id: 'fault-batch',
    pre_image_hashes: preImageHashes,
    post_image_hashes: postImageHashes,
  })
  flushSessionEventLog(runDir, eventLog)
  stopAt('after_mutation_revision')

  recordEffectTerminal(runDir, ledgerIntent, {
    status: 'completed',
    postImageHashes,
  })
  stopAt('after_terminal_persist')

  recordToolTerminal(eventLog, {
    turn_id: turnId,
    tool_call_id: 'fault-tool',
    tool_name: ledgerIntent.toolName,
    idempotency_key: ledgerIntent.operationId,
    exit_code: 0,
    content: 'fixture passed',
  })
  flushSessionEventLog(runDir, eventLog)
}

function runChild(runDir: string, effectClass: ToolEffectClass, faultPoint: FaultPoint): number | null {
  const scriptPath = fileURLToPath(import.meta.url)
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', scriptPath, '--worker', runDir, effectClass],
    {
      cwd: join(dirname(scriptPath), '..'),
      env: { ...process.env, BABEL_FAULT_POINT: faultPoint },
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  )
  return result.status
}

function evaluateRow(runDir: string, effectClass: ToolEffectClass, faultPoint: FaultPoint, childExitCode: number | null): FaultRow {
  const ledger = loadEffectLedger(runDir)
  const interrupted = findInterruptedEffects(ledger)
  const terminal = ledger.filter((record) => record.status !== 'intent')
  const eventLog = loadSessionEventLogFromDir(runDir)
  const mutationEvents = eventLog?.events.filter((event) => event.kind === 'mutation_batch') ?? []
  const intent = interrupted[0]
  const currentImageHashes = faultPoint === 'after_side_effect' || faultPoint === 'after_mutation_revision' || faultPoint === 'after_terminal_persist'
    ? { 'workspace.txt': 'after' }
    : { 'workspace.txt': 'before' }
  const decision = intent
    ? reconcileInterruptedEffect(intent, currentImageHashes)
    : 'not_interrupted'
  const duplicateMutation = mutationEvents.length > 1
  const expectedCrash = faultPoint !== 'after_terminal_persist'
  const safeRecovery = effectClass === 'non_idempotent_local_effect' || effectClass === 'external_side_effect'
    ? decision === 'manual_review'
    : decision === 'retry_reconcilable' || decision === 'recovered_complete' || decision === 'workspace_conflict'
  return {
    effectClass,
    faultPoint,
    childExitCode,
    interruptedCount: interrupted.length,
    terminalCount: terminal.length,
    decision,
    duplicateMutation,
    pass: expectedCrash
      ? childExitCode === FAULT_EXIT_CODE && interrupted.length === 1 && safeRecovery && !duplicateMutation
      : childExitCode === FAULT_EXIT_CODE && interrupted.length === 0 && terminal.length === 1 && !duplicateMutation,
  }
}

export function runExecutorFaultInjection(): FaultReport {
  const root = mkdtempSync(join(tmpdir(), 'babel-executor-fault-'))
  const rows: FaultRow[] = []
  try {
    for (const effectClass of EFFECT_CLASSES) {
      for (const faultPoint of FAULT_POINTS) {
        const runDir = join(root, `${effectClass}-${faultPoint}`)
        const childExitCode = runChild(runDir, effectClass, faultPoint)
        rows.push(evaluateRow(runDir, effectClass, faultPoint, childExitCode))
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return {
    schemaVersion: 1,
    matrixSize: rows.length,
    passed: rows.filter((row) => row.pass).length,
    failed: rows.filter((row) => !row.pass).length,
    duplicateMutations: rows.filter((row) => row.duplicateMutation).length,
    rows,
  }
}

if (process.argv[2] === '--worker') {
  writeChildRun(process.argv[3]!, process.argv[4] as ToolEffectClass)
} else {
  const report = runExecutorFaultInjection()
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.failed > 0) process.exitCode = 1
}
