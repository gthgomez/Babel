import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture, fixturePrompt, type FixtureTaskId } from '../fixtures/claude-babel-astra-lab/fixtures.js'
import type { ControlledRun } from './contracts.js'
import { compareCells, digest, normalizeCapabilities, preflight, type ArmIdentity, type CellResult, type Harness, type PairContract, type PairResult, type Termination } from './comparison-contract.js'
import { evaluateFrozen, freezeEvaluator } from './frozen-evaluator.js'
import { writeComparisonReports } from './comparison-report.js'
import { runnerIdentity } from './runner-identity.js'

export interface ComparisonAdapter {
  /** Must observe effective authority/version; configuration intent alone is insufficient. */
  describe(): Promise<ArmIdentity>
  execute(input: { fixture: ReturnType<typeof createFixture>; contract: PairContract; outputRoot: string; signal: AbortSignal }): Promise<ControlledRun>
}
export interface CampaignOptions {
  outputRoot: string
  adapters: Record<Harness, ComparisonAdapter>
  signal?: AbortSignal
}

function emptyCell(contract: PairContract, harness: Harness, packet: string): CellResult {
  const arm = contract?.arms?.[harness]
  const unavailable: ArmIdentity['capabilities'] = { filesystem: { read: [], write: [] }, network: [], process: [], environment: [], limits: { timeoutMs: 0, modelCalls: null, toolCalls: null, outputTokens: null } }
  let capabilities = unavailable
  try { capabilities = normalizeCapabilities(arm.capabilities) } catch { /* preflight records the missing manifest */ }
  return {
    harness, contract, CONTRACT_DIGEST: digest(contract), EFFECTIVE_CAPABILITY_MANIFEST: capabilities,
    CAPABILITY_DIGEST: digest(capabilities), REQUESTED_PROVIDER: arm?.requestedProvider ?? 'UNKNOWN',
    REQUESTED_MODEL: arm?.requestedModel ?? 'UNKNOWN', OBSERVED_PROVIDER: 'UNKNOWN', OBSERVED_MODEL: 'UNKNOWN', fallback: 'UNKNOWN',
    attempted: false, invalidReasons: [], EXECUTION_SUCCESS: 'UNKNOWN', VERIFIER_SUCCESS: 'UNKNOWN', TASK_CORRECTNESS: 'UNKNOWN', HARNESS_EFFECT: 'INCONCLUSIVE',
    VERIFIER_ID: contract?.verifier?.id ?? 'UNKNOWN', VERIFIER_DIGEST: contract?.verifier?.digest ?? 'UNKNOWN', VERIFIER_COMMAND: contract?.verifier?.command ?? [],
    VERIFIER_RESULT: 'UNKNOWN', VERIFIER_PRODUCER: 'independent-evaluator',
    termination: { kind: 'NORMAL', evidence: [] }, FAILURES_ENCOUNTERED: [], ACTIONABLE_DIAGNOSTICS_OBSERVED: 'UNKNOWN', RETRIES: 'UNKNOWN', RECOVERY_SUCCESS: 'UNKNOWN', CAUSE_IDENTIFICATION: 'UNKNOWN',
    metrics: { wallTimeMs: 'UNKNOWN', modelCalls: 'UNKNOWN', toolCalls: 'UNKNOWN', inputTokens: 'UNKNOWN', outputTokens: 'UNKNOWN', cost: 'UNKNOWN' },
    changedFiles: [], evidence: { packet, trajectory: 'UNKNOWN', receipt: 'UNKNOWN', verifier: 'UNKNOWN' },
  }
}
const terminations: Termination[] = ['NORMAL', 'PROVIDER_TIMEOUT', 'HARNESS_TIMEOUT', 'RUNNER_TIMEOUT', 'RUNNER_CANCELLED', 'BUDGET_EXCEEDED', 'PROCESS_HANG', 'EXTERNAL_INTERRUPTION', 'UNKNOWN_TIMEOUT', 'UNKNOWN_FAILURE']

async function runCell(contract: PairContract, harness: Harness, dir: string, options: CampaignOptions, unsettledContestant = false): Promise<CellResult> {
  const cell = emptyCell(contract, harness, join(dir, 'cell.json'))
  mkdirSync(dir, { recursive: true })
  try {
    cell.invalidReasons = preflight(contract, harness)
    if (unsettledContestant) {
      cell.invalidReasons.push('ACTIVE_CONTESTANT_UNSETTLED')
      cell.termination = { kind: 'PROCESS_HANG', evidence: ['Earlier contestant remains active; shared single-harness resource limit prevents another execution'] }
      return cell
    }
    if (options.signal?.aborted) { cell.termination = { kind: 'RUNNER_CANCELLED', evidence: ['campaign AbortSignal before execution'] }; return cell }
    if (cell.invalidReasons.length) return cell
    const runner = runnerIdentity()
    if (runner.sha !== contract.runnerSha) { cell.invalidReasons.push('RUNNER_SHA_MISMATCH'); return cell }
    cell.RUNNER_SOURCE_DIGEST = runner.sourceDigest
    writeFileSync(join(dir, 'runner-source.json'), `${JSON.stringify(runner, null, 2)}\n`, { flag: 'wx' })
    const observed = await options.adapters[harness].describe()
    if (digest({ ...observed, capabilities: normalizeCapabilities(observed.capabilities) }) !== digest({ ...contract.arms[harness], capabilities: normalizeCapabilities(contract.arms[harness].capabilities) })) {
      cell.invalidReasons.push('RUNTIME_IDENTITY_OR_CAPABILITY_DRIFT'); return cell
    }
    const task = contract.taskId as FixtureTaskId
    if (!['T1', 'T2', 'T4'].includes(task)) { cell.invalidReasons.push('UNSUPPORTED_FROZEN_TASK'); return cell }
    const evaluator = freezeEvaluator(task)
    if (evaluator.digest !== contract.verifier.digest || evaluator.id !== contract.verifier.id || digest(evaluator.command) !== digest(contract.verifier.command)) { cell.invalidReasons.push('INVALID_VERIFIER'); return cell }
    const fixture = createFixture(task)
    if (fixture.baseSha !== contract.fixtureSha || fixture.baseSha !== contract.baseSha || fixturePrompt(task) !== contract.instructions) { cell.invalidReasons.push('FIXTURE_OR_INSTRUCTIONS_MISMATCH'); return cell }
    // Contract and evaluator are frozen before any contestant code runs.
    const snapshot = structuredClone(contract)
    writeFileSync(join(dir, 'contract.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
    cell.attempted = true
    const controller = new AbortController()
    let deadline: ReturnType<typeof setTimeout> | undefined
    let triggered: 'RUNNER_TIMEOUT' | 'RUNNER_CANCELLED' | undefined
    const cancel = (): void => { triggered = 'RUNNER_CANCELLED'; controller.abort() }
    options.signal?.addEventListener('abort', cancel, { once: true })
    const execution = options.adapters[harness].execute({ fixture, contract: structuredClone(snapshot), outputRoot: dir, signal: controller.signal })
    let run: ControlledRun
    try {
      const interrupted = new Promise<never>((_, reject) => {
        const rejectAbort = (): void => reject(new Error(triggered ?? 'RUNNER_CANCELLED'))
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        deadline = setTimeout(() => { triggered = 'RUNNER_TIMEOUT'; controller.abort() }, contract.arms[harness].capabilities.limits.timeoutMs)
      })
      run = await Promise.race([execution, interrupted])
    } catch (error) {
      if (!triggered) throw error
      let grace: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([execution.then(result => ({ result }), () => ({ result: undefined })), new Promise<undefined>(resolve => { grace = setTimeout(() => resolve(undefined), 5_000) })])
      if (grace) clearTimeout(grace)
      cell.EXECUTION_SUCCESS = false
      cell.termination = { kind: settled ? triggered : 'PROCESS_HANG', evidence: [`${triggered}; adapter AbortSignal sent; settled=${settled !== undefined}; no evaluator executed`] }
      if (!settled?.result) return cell
      run = settled.result
    } finally {
      if (deadline) clearTimeout(deadline)
      options.signal?.removeEventListener('abort', cancel)
    }
    const audit = run.audit
    cell.OBSERVED_PROVIDER = audit?.observedProvider ?? 'UNKNOWN'
    cell.OBSERVED_MODEL = audit?.observedModel ?? 'UNKNOWN'
    cell.fallback = audit?.fallback ?? 'UNKNOWN'
    cell.EXECUTION_SUCCESS = audit?.executionSuccess ?? 'UNKNOWN'
    cell.termination = audit && terminations.includes(audit.termination.kind as Termination) ? { kind: audit.termination.kind as Termination, evidence: audit.termination.evidence } : { kind: 'UNKNOWN_FAILURE', evidence: ['missing classified adapter termination'] }
    if (triggered) {
      cell.EXECUTION_SUCCESS = false
      cell.termination = { kind: triggered, evidence: [`${triggered}; adapter settled after AbortSignal; retained flushed evidence`, ...cell.termination.evidence] }
    }
    cell.FAILURES_ENCOUNTERED = audit?.failures ?? []
    cell.RETRIES = audit?.retries ?? 'UNKNOWN'
    cell.RECOVERY_SUCCESS = audit?.recoverySuccess ?? 'UNKNOWN'
    cell.ACTIONABLE_DIAGNOSTICS_OBSERVED = audit?.actionableDiagnostics ?? 'UNKNOWN'
    cell.changedFiles = run.receipt.FILES_CHANGED
    cell.metrics = { wallTimeMs: run.receipt.WALL_TIME, modelCalls: run.receipt.MODEL_CALLS, toolCalls: run.receipt.TOOL_CALLS, inputTokens: run.receipt.INPUT_TOKENS, outputTokens: run.receipt.OUTPUT_TOKENS, cost: 'UNKNOWN' }
    cell.evidence.trajectory = run.rawTrajectory
    // Legacy contestant receipt remains immutable; the v2 receipt is separate.
    if (!triggered && cell.termination.kind !== 'PROCESS_HANG') {
      const verification = evaluateFrozen(fixture.root, evaluator, join(dir, 'verifier'))
      Object.assign(cell, verification)
      cell.VERIFIER_COMMAND = [...verification.VERIFIER_COMMAND]
      cell.VERIFIER_SUCCESS = verification.VERIFIER_RESULT === 'INVALID' ? 'UNKNOWN' : verification.VERIFIER_RESULT === 'PASS'
      cell.evidence.verifier = verification.evidencePath
      if (cell.RECOVERY_SUCCESS === true && verification.TASK_CORRECTNESS !== 'PASS') cell.RECOVERY_SUCCESS = verification.TASK_CORRECTNESS === 'FAIL' ? false : 'UNKNOWN'
      if (verification.tampered) cell.invalidReasons.push('INVALID_VERIFIER')
    }
  } catch (error) {
    cell.EXECUTION_SUCCESS = false
    cell.termination = { kind: 'UNKNOWN_FAILURE', evidence: [error instanceof Error ? error.name : 'unknown runner exception'] }
    cell.invalidReasons.push('CELL_EXECUTION_OR_EVALUATOR_ERROR')
  } finally {
    cell.evidence.receipt = join(dir, 'receipt-v2.json')
    writeFileSync(cell.evidence.receipt, `${JSON.stringify(cell, null, 2)}\n`, { flag: 'wx' })
    writeFileSync(cell.evidence.packet, `${JSON.stringify(cell, null, 2)}\n`, { flag: 'wx' })
  }
  return cell
}

/** Sequential, bounded campaign. One invalid cell never stops later pairs. */
export async function runComparisonCampaign(contracts: PairContract[], options: CampaignOptions): Promise<PairResult[]> {
  if (existsSync(options.outputRoot) && readdirSync(options.outputRoot).length) throw new Error('OUTPUT_ALREADY_EXISTS: choose a fresh directory; historical artifacts are immutable')
  mkdirSync(options.outputRoot, { recursive: true })
  const pairs: PairResult[] = []
  let unsettledContestant = false
  for (const [i, input] of contracts.entries()) {
    const contract = structuredClone(input)
    const dir = join(options.outputRoot, `pair-${i + 1}`)
    const claude = await runCell(contract, 'claude-code', join(dir, 'claude'), options, unsettledContestant)
    unsettledContestant ||= claude.termination.kind === 'PROCESS_HANG'
    const babel = await runCell(contract, 'babel-live', join(dir, 'babel'), options, unsettledContestant)
    unsettledContestant ||= babel.termination.kind === 'PROCESS_HANG'
    pairs.push(compareCells(claude, babel))
  }
  writeComparisonReports(join(options.outputRoot, 'reports'), pairs)
  return pairs
}
