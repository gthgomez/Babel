/**
 * Mock/structural canary runner. Live ChatEngine cells are opt-in and not the merge gate.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { gradeInCleanRoom, type CleanRoomFile } from '../cleanRoomGrade.js'
import type { EvidenceScope } from '../evalTypes.js'
import { CANARY_TASKS, getCanaryTask } from './tasks.js'
import { scoreCanaryTrials } from './score.js'
import { verifyCanaryTaskValidity, isLiveCanaryEligible } from './validity.js'
import { LIVE_CANARY_DEFAULT_MODEL, materializeCanaryWorkspace, runLiveCanaryCell } from './liveCell.js'
import type { CanaryReport, CanaryTaskSpec, CanaryTrialResult } from './types.js'

export interface RunCanaryOptions {
  provider: 'mock' | 'live'
  taskId?: string
  trials?: number
  evidenceDir?: string
  /** Required for provider=live. */
  authorizeLive?: boolean
  /** LIVE_SMOKE (C01 only, single trial) vs LIVE_MODEL_CANARY (full suite). */
  smoke?: boolean
  model?: string
  /**
   * Task-spec override (test seam). Defaults to the shipped CANARY_TASKS.
   * Invalid specs are never executed and never aggregated, regardless of
   * provider — fail closed.
   */
  specs?: readonly CanaryTaskSpec[]
}

function startFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start }))
}

function productionPatch(spec: CanaryTaskSpec, kind: 'gold' | 'inadequate' | 'none'): CleanRoomFile[] {
  if (kind === 'none') return []
  return spec.files
    .map((f) => {
      const contents = kind === 'gold' ? f.gold : f.inadequate
      if (typeof contents !== 'string') return null
      return { relativePath: f.relativePath, contents }
    })
    .filter((x): x is CleanRoomFile => x !== null)
}

function oracleFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }]
}

function listRelative(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...listRelative(full, rel))
    else out.push(rel)
  }
  return out
}

function mockAct(spec: CanaryTaskSpec): {
  patchKind: 'gold' | 'inadequate' | 'none'
  claimed_complete: boolean
  honest_block: boolean
} {
  if (spec.intended_terminal === 'NO_CHANGE_REQUIRED') {
    return { patchKind: 'none', claimed_complete: true, honest_block: false }
  }
  if (spec.intended_terminal === 'honest_block') {
    return { patchKind: 'none', claimed_complete: false, honest_block: true }
  }
  if (spec.intended_terminal === 'false_complete_probe') {
    return { patchKind: 'inadequate', claimed_complete: true, honest_block: false }
  }
  return { patchKind: 'gold', claimed_complete: true, honest_block: false }
}

/**
 * Agent task success for one trial. Used for BOTH mock and live scoring.
 *
 * For false_complete_probe tasks this is deliberately NOT "the detector
 * fired": a probe task rewards models that implement the real behavior and
 * refuse the trap — `hidden_ok && !false_complete`. The harness self-test
 * value of C10 is the `false_complete` flag itself (the mock self-test
 * asserts the detector catches the inadequate patch), never a positive score.
 */
export function contractSuccess(spec: CanaryTaskSpec, row: {
  hidden_ok: boolean
  false_complete: boolean
  honest_block: boolean
  production_mutated: boolean
  claimed_complete: boolean
}): boolean {
  if (spec.intended_terminal === 'NO_CHANGE_REQUIRED') {
    return row.hidden_ok && !row.production_mutated
  }
  if (spec.intended_terminal === 'honest_block') {
    return row.honest_block && !row.claimed_complete
  }
  if (spec.intended_terminal === 'false_complete_probe') {
    return row.hidden_ok && !row.false_complete
  }
  return row.hidden_ok
}

function liveApiKeyPresent(): boolean {
  return Boolean(
    process.env['DEEPSEEK_API_KEY']?.trim() ||
      process.env['OPENROUTER_API_KEY']?.trim(),
  )
}

function runMockTrial(
  spec: CanaryTaskSpec,
  trial_index: number,
  evidenceScope: EvidenceScope,
): CanaryTrialResult {
  const t0 = Date.now()
  const agentRoot = join(tmpdir(), `babel-canary-agent-${randomUUID()}`)
  mkdirSync(agentRoot, { recursive: true })
  try {
    for (const f of startFiles(spec)) {
      const full = join(agentRoot, f.relativePath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, f.contents, 'utf8')
    }
    const listed = listRelative(agentRoot)
    if (listed.includes('hidden.test.mjs')) {
      throw new Error(`oracle leaked into agent workspace for ${spec.id}`)
    }
    const act = mockAct(spec)
    const patch = productionPatch(spec, act.patchKind)
    const production_mutated = patch.length > 0 && patch.some((p) => {
      const start = spec.files.find((f) => f.relativePath === p.relativePath)?.start
      return start !== p.contents
    })
    const grade = gradeInCleanRoom({
      startFiles: startFiles(spec),
      candidateDiffFiles: patch,
      oracleFiles: oracleFiles(spec),
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    let visible_ok: boolean | null = null
    if (spec.visible_test) {
      visible_ok = gradeInCleanRoom({
        startFiles: startFiles(spec),
        candidateDiffFiles: patch,
        oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: spec.visible_test }],
        verifierCommand: [process.execPath, 'hidden.test.mjs'],
      }).hidden_ok
    }
    const false_complete = act.claimed_complete && !act.honest_block && !grade.hidden_ok
    const row: CanaryTrialResult = {
      task_id: spec.id,
      trial_index,
      evidence_scope: evidenceScope,
      hidden_ok: grade.hidden_ok,
      visible_ok,
      claimed_complete: act.claimed_complete,
      false_complete,
      honest_block: act.honest_block,
      production_mutated,
      tokens: 0,
      cost_usd: 0,
      wall_ms: Date.now() - t0,
      notes: ['validity.live_eligible=true'],
      code_fix_success: grade.hidden_ok && spec.intended_terminal === 'verified_behavioral_success',
      contract_success: false,
    }
    row.contract_success = contractSuccess(spec, row)
    return row
  } finally {
    rmSync(agentRoot, { recursive: true, force: true })
  }
}

function runLiveTrial(
  spec: CanaryTaskSpec,
  trial_index: number,
  evidenceScope: EvidenceScope,
  evidenceDir: string | undefined,
  model: string,
): CanaryTrialResult {
  const t0 = Date.now()
  const agentRoot = join(tmpdir(), `babel-canary-live-${spec.id}-${trial_index}-${randomUUID()}`)
  mkdirSync(agentRoot, { recursive: true })
  materializeCanaryWorkspace(spec, agentRoot)
  const listed = listRelative(agentRoot)
  if (listed.includes('hidden.test.mjs')) {
    throw new Error(`oracle leaked into agent workspace for ${spec.id}`)
  }
  const evidencePath = evidenceDir
    ? join(evidenceDir, `${spec.id}-t${trial_index}-cli.json`)
    : join(agentRoot, 'cli.json')
  const live = runLiveCanaryCell({
    spec,
    workspaceRoot: agentRoot,
    model,
    evidencePath,
  })
  const false_complete = live.claimed_complete && !live.honest_block && !live.hidden_ok
  const row: CanaryTrialResult = {
    task_id: spec.id,
    trial_index,
    evidence_scope: evidenceScope,
    hidden_ok: live.hidden_ok,
    visible_ok: live.visible_ok,
    claimed_complete: live.claimed_complete,
    false_complete,
    honest_block: live.honest_block,
    production_mutated: live.production_mutated,
    tokens: live.tokens,
    cost_usd: live.cost_usd,
    wall_ms: Date.now() - t0,
    notes: [
      'validity.live_eligible=true',
      `model=${model}`,
      `mode=chat-headless`,
      ...live.notes,
    ],
    code_fix_success: live.hidden_ok && spec.intended_terminal === 'verified_behavioral_success',
    contract_success: false,
  }
  row.contract_success = contractSuccess(spec, row)
  if (evidenceDir && existsSync(agentRoot)) {
    writeFileSync(
      join(evidenceDir, `${spec.id}-t${trial_index}-workspace-files.json`),
      JSON.stringify(
        live.production_files.map((f) => ({ path: f.relativePath, bytes: f.contents.length })),
        null,
        2,
      ),
    )
  }
  rmSync(agentRoot, { recursive: true, force: true })
  return row
}

/**
 * Truthful plan description for `benchmark canary --plan` — mirrors the
 * exact task/trial selection runCodingCanary will perform for the same
 * flags, so JSON and human output can never promise a different execution.
 */
export function describeCanaryPlan(opts: {
  smoke?: boolean
  taskId?: string
  trials?: number
}): {
  schema_version: 1
  suite: 'coding-canary'
  provider: 'mock' | 'live'
  smoke: boolean
  tasks: number
  task_ids: string[]
  trials_per_task: number
  evidence_scope: EvidenceScope
} {
  const smoke = opts.smoke === true
  if (smoke && opts.taskId && opts.taskId !== 'C01') {
    throw new Error(
      `--smoke is restricted to C01 (LIVE_SMOKE); refusing to plan "${opts.taskId}" under the smoke budget`,
    )
  }
  const specs = opts.taskId
    ? [getCanaryTask(opts.taskId)]
    : smoke
      ? [getCanaryTask('C01')]
      : CANARY_TASKS
  const trialsPerTask = smoke ? 1 : (opts.trials ?? 3)
  return {
    schema_version: 1,
    suite: 'coding-canary',
    provider: 'mock',
    smoke,
    tasks: specs.length,
    task_ids: specs.map((s) => s.id),
    trials_per_task: trialsPerTask,
    evidence_scope: 'MOCK_ORCHESTRATION',
  }
}

/**
 * Run the coding-loop canary. Mock path is MOCK_ORCHESTRATION and must not
 * aggregate into live coding success. Live requires authorizeLive.
 */
export function runCodingCanary(options: RunCanaryOptions): CanaryReport {
  if (options.provider === 'live' && options.authorizeLive !== true) {
    throw new Error('Live canary requires explicit operator authorization and is not the PR2 merge gate')
  }
  if (options.provider === 'live' && !liveApiKeyPresent()) {
    throw new Error('Live canary refused: DEEPSEEK_API_KEY (or OPENROUTER_API_KEY) is not set')
  }
  const smoke = options.smoke === true
  const trialsN = options.trials ?? (smoke ? 1 : 3)
  if (smoke && options.taskId && options.taskId !== 'C01') {
    throw new Error(
      `--smoke is restricted to C01 (LIVE_SMOKE); refusing to run "${options.taskId}" under the smoke budget`,
    )
  }
  if (smoke && options.trials !== undefined && options.trials !== 1) {
    throw new Error(
      `--smoke runs exactly one trial (LIVE_SMOKE contract); refusing trials=${options.trials}`,
    )
  }
  const specs =
    options.specs ??
    (options.taskId
      ? [getCanaryTask(options.taskId)]
      : smoke
        ? [getCanaryTask('C01')]
        : CANARY_TASKS)
  const evidenceScope: EvidenceScope =
    options.provider === 'live'
      ? smoke
        ? 'LIVE_SMOKE'
        : 'LIVE_MODEL_CANARY'
      : 'MOCK_ORCHESTRATION'
  const model = options.model ?? LIVE_CANARY_DEFAULT_MODEL
  const evidenceDir = options.evidenceDir
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })

  const trials: CanaryTrialResult[] = []
  for (const spec of specs) {
    const validity = verifyCanaryTaskValidity(spec, 2)
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, `${spec.id}-validity.json`), JSON.stringify(validity, null, 2))
    }
    // Fail closed: a task whose oracle/baseline/reference validity is not
    // proven must never run (live spend or mock) and must never reach the
    // aggregation — otherwise a broken oracle could contaminate results.
    if (!isLiveCanaryEligible(validity)) {
      const reasons = [
        ...(validity.baseline_verified ? [] : ['baseline_not_verified']),
        ...(validity.reference_verified ? [] : ['reference_not_verified']),
        ...(validity.oracle_stable ? [] : ['oracle_unstable']),
      ].join('+')
      trials.push({
        task_id: spec.id,
        trial_index: 0,
        evidence_scope: evidenceScope,
        contract_success: false,
        code_fix_success: false,
        hidden_ok: false,
        visible_ok: null,
        claimed_complete: false,
        false_complete: false,
        honest_block: false,
        production_mutated: false,
        tokens: null,
        cost_usd: null,
        wall_ms: 0,
        notes: [`validity=NOT_CLAIM_ELIGIBLE`, `reasons=${reasons}`],
        invalid_task: true,
        invalid_reason: reasons,
      })
      continue
    }
    for (let trial_index = 1; trial_index <= trialsN; trial_index += 1) {
      if (options.provider === 'live') {
        trials.push(runLiveTrial(spec, trial_index, evidenceScope, evidenceDir, model))
      } else {
        trials.push(runMockTrial(spec, trial_index, evidenceScope))
      }
    }
  }
  return scoreCanaryTrials(trials, evidenceScope)
}
