/**
 * Explicit, offline Docker qualification for recovery in an unborn Git tree.
 * Run with the repository-pinned Python image already present locally:
 * BABEL_RUN_DOCKER_RECOVERY_QUALIFICATION=1 node --import tsx \
 *   scripts/qualify_chat_recovery_unborn_docker.ts
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from '../src/agent/chatEngine.js'
import type { ChatToolAction } from '../src/agent/chatToolDefinitions.js'
import type { ToolContext } from '../src/localTools.js'
import { recordToolProposed, recordToolTerminal } from '../src/agent/sessionEvents.js'
import type { WorkingState } from '../src/agent/codingLoop/workingState.js'
import { recoveryObservationId } from '../src/agent/codingLoop/recoveryPlan.js'
import { resolveExecutorDryRun } from '../src/config/dryRun.js'
import { readRuntimeMode } from '../src/config/runtimeMode.js'

const IMAGE = 'docker.io/library/python@sha256:061c190f3d5815b341a18dfe8a45771f8ba68c15a607ea56997fde3009ac4eec'
const names = [
  'BABEL_RUN_DOCKER_RECOVERY_QUALIFICATION', 'BABEL_RUNS_DIR', 'BABEL_LIVE', 'BABEL_EXECUTION_PROFILE',
  'BABEL_BENCHMARK_DOCKER_IMAGE', 'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS', 'BABEL_DOCKER_DISABLE',
  'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_DOCKER_HOST_NETWORK',
] as const

async function qualify(): Promise<void> {
  assert.equal(process.env['BABEL_RUN_DOCKER_RECOVERY_QUALIFICATION'], '1', 'explicit local qualification opt-in is required')
  assert.equal(process.env['BABEL_SHADOW_ROOT']?.trim() ?? '', '',
    'qualification cannot validate shadow writes because verifier commands run against the project workspace')
  assert.equal(readRuntimeMode(), 'act', 'qualification requires Act Mode')
  const image = spawnSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8' })
  assert.equal(image.status, 0, `pinned image must already exist locally: ${image.stderr}`)
  assert.match(image.stdout.trim(), /^sha256:/)

  const storage = mkdtempSync(join(tmpdir(), 'babel-unborn-recovery-'))
  const root = join(storage, 'project')
  const runDir = join(storage, 'runtime')
  mkdirSync(root); mkdirSync(runDir)
  const previous = names.map(name => [name, process.env[name]] as const)
  try {
    process.env['BABEL_RUNS_DIR'] = join(storage, 'runs')
    process.env['BABEL_LIVE'] = 'true'
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = IMAGE
    process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] = '--user 1000:1000'
    delete process.env['BABEL_DOCKER_DISABLE']
    delete process.env['BABEL_ALLOW_HOST_FALLBACK']
    delete process.env['BABEL_DOCKER_HOST_NETWORK']
    assert.equal(resolveExecutorDryRun().dryRun, false,
      'qualification must have an effective live mutation opt-in after BABEL_LIVE is set')

    execFileSync('git', ['init', '--quiet'], { cwd: root })
    const original = 'def answer():\n    """Return the expected value.\n\n    >>> answer()\n    1\n    """\n    return 0\n'
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status, 0,
      'the test fixture must have no commit')

    const command = 'python -m doctest solution.py -v'
    const task = 'Fix the failing doctest in solution.py. Run `python -m doctest solution.py -v` before completion. Preserve the examples.'
    const engine = new ChatEngine({ task, projectRoot: root, requiredVerifierCommands: [command] })
    engine.admitUserSubmission({ userInput: task }, { model: 'offline-qualification', provider: 'ollama' })
    const host = engine as unknown as {
      _turnIndex: number
      activeSubmissionGeneration: number
      parity: { turnId: string; sessionEvents: import('../src/agent/sessionEvents.js').SessionEventLog }
      workingState: WorkingState
      toolCallLog: Array<{ exit_code?: number; error?: string; stdout?: string; stderr?: string }>
      lastVerifierReceipt: { exit_code: number; stale: boolean; boundRevision?: { gitCommitHash: string | null; scope?: { kind: string } }; tests_total?: number } | null
      currentRecoveryBinding: () => { sessionId: string; workspaceRevision: string; executionContextHash: string } | null
      executeOneAction: (action: ChatToolAction, context: ToolContext, callbacks: object,
        meta: { index: number; idempotencyKey: string; ownerGeneration: number }) => Promise<{ observation: string }>
    }
    const context: ToolContext = { agentId: 'qualification', runId: 'qualification', runDir, babelRoot: root, projectRoot: root }
    const run = async (action: ChatToolAction): Promise<{ observation: string }> => {
      const id = `unborn-recovery-${++host._turnIndex}`
      const turn = host.parity.turnId
      recordToolProposed(host.parity.sessionEvents, { turn_id: turn, tool_call_id: id, tool_name: action.type })
      const result = await host.executeOneAction(action, context, {}, {
        index: host._turnIndex, idempotencyKey: id, ownerGeneration: host.activeSubmissionGeneration,
      })
      const row = host.toolCallLog.at(-1)!
      const started = host.parity.sessionEvents.events.some(event => event.kind === 'tool_started' && event.tool_call_id === id)
      recordToolTerminal(host.parity.sessionEvents, {
        turn_id: turn, tool_call_id: id, tool_name: action.type,
        ...(started ? { ...(row.exit_code !== undefined ? { exit_code: row.exit_code } : {}), content: result.observation, failed: !!row.error }
          : { cancelled: true, reason: 'pre_dispatch_denied_or_invalid', recovery_state: 'TOOL_NOT_STARTED' as const }),
      })
      return result
    }

    const firstBinding = host.currentRecoveryBinding()
    assert.ok(firstBinding?.workspaceRevision)
    assert.equal(firstBinding.sessionId, host.parity.sessionEvents.session_id)
    assert.match(firstBinding.executionContextHash, /^[a-f0-9]{64}$/)

    const write = await run({ type: 'write_file', path: 'solution.py', content: original })
    assert.match(write.observation, /static_check solution\.py\nexit_code: 0/)
    assert.equal(existsSync(join(root, '__pycache__')), false, 'host syntax validation must leave no bytecode cache')

    const red = await run({ type: 'test_run', command })
    assert.match(red.observation, /exit_code: 1/)
    assert.match(red.observation, /solution\.py:4/)
    assert.equal(host.workingState.failureSurface?.kind, 'TEST_FAILURE', 'the real doctest mismatch must be localized as a test red')
    assert.equal(host.lastVerifierReceipt?.exit_code, 1)
    assert.equal(host.lastVerifierReceipt?.boundRevision?.gitCommitHash, null, 'the red receipt uses content-only scope')
    assert.equal(host.lastVerifierReceipt?.boundRevision?.scope?.kind, 'files')
    assert.ok(host.workingState.settledFailedVerifier, 'the real Docker process start and failure are durably bound')
    assert.equal(host.workingState.settledFailedVerifier.candidate.sessionId, host.parity.sessionEvents.session_id)
    assert.equal(host.workingState.recoveryGate?.binding?.sessionId, host.parity.sessionEvents.session_id)

    const read = await run({ type: 'read_file', path: 'solution.py' })
    assert.match(read.observation, /return 0/)
    const gate = host.workingState.recoveryGate!
    assert.ok(gate.satisfied, 'a fresh governed source read satisfies the failed-verifier evidence gate')
    const repairPlan = {
      schemaVersion: 1 as const, failureSignature: gate.failureSignature, workspaceRevision: gate.binding!.workspaceRevision,
      hypothesisClass: 'logic' as const, targetIdentities: ['solution.py'], actionFamily: 'str_replace' as const,
      criterionId: host.workingState.lastVerifier!.identity,
      supportingObservationIds: gate.observedKeys!.map(recoveryObservationId),
    }
    const repair = await run({ type: 'str_replace', file_path: 'solution.py', old_str: '    return 0', new_str: '    return 1', repair_plan: repairPlan })
    assert.doesNotMatch(repair.observation, /RECOVERY_CANDIDATE_DRIFT|RECOVERY_EVIDENCE_REQUIRED|RECOVERY_PLAN_REQUIRED/)
    assert.equal(readFileSync(join(root, 'solution.py'), 'utf8'), original.replace('    return 0', '    return 1'))
    assert.equal(existsSync(join(root, '__pycache__')), false)

    const green = await run({ type: 'test_run', command })
    assert.match(green.observation, /exit_code: 0/)
    assert.match(green.observation, /1 passed and 0 failed/)
    assert.equal(host.lastVerifierReceipt?.exit_code, 0)
    assert.equal(host.lastVerifierReceipt?.stale, false)
    assert.equal(host.workingState.recoveryGate, undefined)
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status === 0, false,
      'successful recovery must not rely on creating a commit')
    console.log(JSON.stringify({ qualification: 'unborn-git-red-read-repair-green', image: IMAGE,
      sessionId: host.parity.sessionEvents.session_id, testCommand: command,
      redFailure: host.workingState.failureSurface?.kind ?? 'cleared-after-green',
      finalReceipt: host.lastVerifierReceipt?.exit_code, workspacePath: root }))
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(storage, { recursive: true, force: true })
  }
}

await qualify()
