import assert from 'node:assert/strict'
import test from 'node:test'
import fs, {
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine } from './chatEngine.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { createEngineFromThreadCells } from '../services/threadStore/conversationSync.js'
import { forkThread } from '../services/threadStore/branching.js'
import {
  appendTurnCells,
  loadThreadCells,
} from '../services/threadStore/threadStore.js'
import { HISTORY_CELL_SCHEMA_VERSION } from '../ui/historyCells/types.js'
import { THREAD_EVENT_LOG_FILENAME } from './threadEventLog.js'
import {
  loadLiveSessionAuthorityStrict,
  resolveLiveSessionAuthority,
} from './liveSessionBridge.js'
import {
  recordVerifierAttempt,
  setSessionEventObservationHook,
  flushSessionEventObservations,
} from './sessionEvents.js'

const route = { model: 'fixture-model', provider: 'ollama' }

test('a fresh fork admits a new objective without importing source execution authority', () =>
  fixture(async (source) => {
    const scope = source.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    source.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const sourceContract = source.getTaskContract()!
    appendTurnCells(source.getEngineRunId(), 1, [
      {
        schema_version: HISTORY_CELL_SCHEMA_VERSION,
        cell_id: 'fixture-user',
        thread_id: source.getEngineRunId(),
        turn_id: 1,
        ts: new Date().toISOString(),
        kind: 'user_message',
        lifecycle: 'committed',
        revision: 0,
        payload: { message: sourceContract.user_request },
      },
    ])
    const fork = await forkThread(source.getEngineRunId())
    const engine = createEngineFromThreadCells(
      fork.new_thread_id,
      { model: 'deepseek-v4-flash-openrouter',
        task: 'Forked fixture',
        projectRoot: scope.projectRoot,
      },
      loadThreadCells(fork.new_thread_id),
    )
    assert.equal(engine.getConversation().length, 1)
    const result = engine.admitUserSubmission(
      { userInput: 'Explain fixture B' },
      route,
    )
    assert.equal(result.status, 'committed')
    assert.notEqual(engine.getTaskContract()!.task_id, sourceContract.task_id)
    assert.equal(engine.getTaskContract()!.user_request, 'Explain fixture B')
    assert.equal(
      engine
        .getParityEventLog()
        .events.filter((event) => event.kind === 'turn_started').length,
      1,
    )
    assert.equal(engine.getLiveSession().authorized_observation_ids.length, 0)
    const before = readFileSync(
      join(chatSessionDir(engine.getEngineRunId()), THREAD_EVENT_LOG_FILENAME),
      'utf8',
    )
    await assert.rejects(
      forkThread(source.getEngineRunId(), {
        newThreadId: engine.getEngineRunId(),
      }),
      /already exists/,
    )
    assert.equal(
      readFileSync(
        join(
          chatSessionDir(engine.getEngineRunId()),
          THREAD_EVENT_LOG_FILENAME,
        ),
        'utf8',
      ),
      before,
    )
    const headless = new ChatEngine({ model: 'deepseek-v4-flash-openrouter',
      task: 'Explain fixture C',
      projectRoot: scope.projectRoot,
    })
    headless.admitUserSubmission({ userInput: 'Explain fixture C' }, route)
    const headlessDir = chatSessionDir(headless.getEngineRunId())
    const headlessFiles = new Map(
      readdirSync(headlessDir)
        .filter((name) => lstatSync(join(headlessDir, name)).isFile())
        .map((name) => [name, readFileSync(join(headlessDir, name), 'utf8')]),
    )
    await assert.rejects(
      forkThread(source.getEngineRunId(), {
        newThreadId: headless.getEngineRunId(),
      }),
      /already exists/,
    )
    for (const [name, bytes] of headlessFiles)
      assert.equal(readFileSync(join(headlessDir, name), 'utf8'), bytes)
    await assert.rejects(
      forkThread(source.getEngineRunId(), { newThreadId: '../escape' }),
      /Invalid fork destination/,
    )
  }))

test('cold continuation records the instructions actually delivered without replacing its objective', () =>
  fixture(async (engine, runDir) => {
    const scope = engine.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    const instructions = join(scope.projectRoot, 'AGENTS.md')
    writeFileSync(instructions, '# Fixture\nUse fixture instruction ONE.\n')
    engine.applyTurnPreparation({
      task: 'Fix fixture A and run its tests',
      executionProfile: 'chat',
    })
    engine.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const accepted = engine.getTaskContract()!
    writeFileSync(instructions, '# Fixture\nUse fixture instruction TWO.\n')
    const restored = await ChatEngine.restore(engine.getEngineRunId(), { model: 'deepseek-v4-flash-openrouter',
      task: 'Resume',
      projectRoot: scope.projectRoot,
    })
    restored.admitUserSubmission({ userInput: 'continue' }, route)
    assert.equal(restored.getTaskContract()!.contract_id, accepted.contract_id)
    assert.equal(
      JSON.stringify(restored.getInstructionManifest()).includes(
        'fixture instruction TWO',
      ),
      true,
    )
    assert.equal(
      JSON.stringify(
        loadLiveSessionAuthorityStrict(runDir).instructionManifest,
      ).includes('fixture instruction TWO'),
      true,
    )
  }))

async function fixture(
  body: (engine: ChatEngine, runDir: string) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'babel-objective-lifecycle-')),
    prior = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter',
      task: 'Fix fixture A and run its tests',
      projectRoot: root,
    })
    await body(engine, chatSessionDir(engine.getEngineRunId()))
  } finally {
    if (prior === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = prior
    rmSync(root, { recursive: true, force: true })
  }
}

test('identical initial requests in separate conversations have distinct task identities', () =>
  fixture((engine) => {
    const scope = engine.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    const other = new ChatEngine({ model: 'deepseek-v4-flash-openrouter',
      task: engine.getTaskContract()!.user_request,
      projectRoot: scope.projectRoot,
    })
    assert.notEqual(other.getEngineRunId(), engine.getEngineRunId())
    assert.notEqual(
      other.getTaskContract()!.task_id,
      engine.getTaskContract()!.task_id,
    )
  }))

test('submission preview is pure and distinguishes objective identity from counter policy', () =>
  fixture((engine, runDir) => {
    assert.equal(
      typeof engine.prepareUserSubmission,
      'function',
      'A pure preparation boundary is required',
    )
    const initial = engine.prepareUserSubmission({
      userInput: 'Fix fixture A and run its tests',
    })
    assert.equal(initial.objectiveDisposition, 'initial')
    engine.applyPreparedUserSubmission(initial)
    const before = engine.getTurnRuntimeSnapshot(),
      contract = engine.getTaskContract()
    const files = new Map(
      readdirSync(runDir)
        .filter((name) => lstatSync(join(runDir, name)).isFile())
        .map((name) => [name, readFileSync(join(runDir, name), 'utf8')]),
    )
    for (const text of ['continue', 'status?', 'also preserve its API']) {
      const prepared = engine.prepareUserSubmission({ userInput: text })
      assert.equal(prepared.objectiveDisposition, 'preserve')
      assert.equal(
        prepared.runtime.durableObjective,
        'Fix fixture A and run its tests',
      )
    }
    const repeated = engine.prepareUserSubmission({
      userInput: 'Fix fixture A and run its tests',
    })
    assert.equal(repeated.objectiveDisposition, 'replace')
    assert.equal(
      engine.prepareUserSubmission({ userInput: 'Explain fixture B' })
        .objectiveDisposition,
      'replace',
    )
    assert.deepEqual(engine.getTurnRuntimeSnapshot(), before)
    assert.equal(engine.getTaskContract(), contract)
    for (const [name, bytes] of files)
      assert.equal(readFileSync(join(runDir, name), 'utf8'), bytes)
  }))

test('a superseded submission cannot publish a new objective generation', (t) =>
  fixture((engine, runDir) => {
    engine.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const original = engine.getTaskContract()!,
      generation = engine as unknown as { activeSubmissionGeneration: number }
    const rename = fs.renameSync
    const mock = t.mock.method(
      fs,
      'renameSync',
      function (source: fs.PathLike, destination: fs.PathLike) {
        const result = rename(source, destination)
        if (basename(String(destination)) === 'task-budget.json')
          generation.activeSubmissionGeneration++
        return result
      },
    )
    syncBuiltinESMExports()
    try {
      assert.throws(
        () =>
          engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route),
        /OBJECTIVE_ADMISSION_NOT_COMMITTED/,
      )
    } finally {
      mock.mock.restore()
      syncBuiltinESMExports()
    }
    assert.equal(
      engine.getTaskContract()!.contract_hash,
      original.contract_hash,
    )
    assert.equal(
      loadLiveSessionAuthorityStrict(runDir).taskContract.contract_hash,
      original.contract_hash,
    )
  }))

for (const fromCells of [false, true])
  for (const target of ['task-objective-lifecycle.json', 'task-budget.json'])
    test(`blocked ${target} publication after ${fromCells ? 'cells resume' : 'live submission'} leaves canonical observations unchanged`, (t) =>
      fixture(async (initialEngine, runDir) => {
        let engine = initialEngine
        engine.admitUserSubmission(
          { userInput: 'Fix fixture A and run its tests' },
          route,
        )
        if (fromCells) {
          const scope = engine.getExecutionScope()
          if (scope.kind !== 'project')
            throw new Error('Project fixture required')
          engine = createEngineFromThreadCells(
            engine.getEngineRunId(),
            { model: 'deepseek-v4-flash-openrouter',
              task: 'Resume fixture',
              projectRoot: scope.projectRoot,
            },
            [],
          )
        }
        const prior = engine.getParityRuntime(),
          runtime = engine.getTurnRuntimeSnapshot(),
          allowance = engine.getTaskAllowanceSnapshot()
        const files = new Map(
          readdirSync(runDir)
            .filter((name) => lstatSync(join(runDir, name)).isFile())
            .map((name) => [name, readFileSync(join(runDir, name), 'utf8')]),
        )
        const rename = fs.renameSync
        const mock = t.mock.method(
          fs,
          'renameSync',
          function (source: fs.PathLike, destination: fs.PathLike) {
            if (basename(String(destination)) === target)
              throw Object.assign(new Error('Fixture publication blocked'), {
                code: 'EACCES',
              })
            return rename(source, destination)
          },
        )
        syncBuiltinESMExports()
        let observed = 0
        await flushSessionEventObservations()
        setSessionEventObservationHook(() => {
          observed++
        })
        try {
          assert.throws(
            () =>
              engine.admitUserSubmission(
                { userInput: 'Explain fixture B' },
                route,
              ),
            /OBJECTIVE_ADMISSION_NOT_COMMITTED/,
          )
        } finally {
          mock.mock.restore()
          syncBuiltinESMExports()
          await flushSessionEventObservations()
          setSessionEventObservationHook(null)
        }
        assert.equal(engine.getParityRuntime(), prior)
        assert.deepEqual(engine.getTurnRuntimeSnapshot(), runtime)
        assert.deepEqual(engine.getTaskAllowanceSnapshot(), allowance)
        assert.equal(observed, 0)
        assert.deepEqual(
          readdirSync(runDir).filter((name) =>
            lstatSync(join(runDir, name)).isFile(),
          ),
          [...files.keys()],
        )
        for (const [name, bytes] of files)
          assert.equal(readFileSync(join(runDir, name), 'utf8'), bytes)
      }))

test('cells-resumed admission publishes each committed event once to retained observers', () =>
  fixture(async (source) => {
    const scope = source.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    source.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const engine = createEngineFromThreadCells(
      source.getEngineRunId(),
      { model: 'deepseek-v4-flash-openrouter',
        task: 'Resume fixture',
        projectRoot: scope.projectRoot,
      },
      [],
    )
    await flushSessionEventObservations()
    const priorLog = engine.getParityRuntime().sessionEvents
    const local: string[] = [],
      global: string[] = []
    const unsubscribe = priorLog.observationBus!.subscribe({
      id: 'objective-fixture',
      onObservation: (value) => {
        local.push(value.payload.event_id)
      },
    })
    setSessionEventObservationHook((event) => {
      global.push(event.event_id)
    })
    try {
      engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
      await flushSessionEventObservations()
      await engine.getParityRuntime().sessionEvents.observationBus!.flush()
      const turnId = engine.getParityRuntime().turnId
      const expected = engine
        .getParityRuntime()
        .sessionEvents.events.filter((event) => event.turn_id === turnId)
        .map((event) => event.event_id)
      assert.ok(expected.length > 0)
      assert.deepEqual(global, expected)
      assert.deepEqual(local, expected)
      assert.equal(
        engine.getParityRuntime().sessionEvents.observationBus,
        priorLog.observationBus,
      )
    } finally {
      unsubscribe()
      setSessionEventObservationHook(null)
    }
  }))

test('objective authority survives mode changes and rejects corrupt or missing attempt lineage', () =>
  fixture((engine, runDir) => {
    engine.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const first = engine.getTaskContract()!.task_id
    engine.applyTurnPreparation({ task: 'continue', executionProfile: 'plan' })
    engine.applyTurnPreparation({ task: 'continue', executionProfile: 'chat' })
    assert.equal(
      loadLiveSessionAuthorityStrict(runDir).taskContract.task_id,
      first,
    )
    engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
    const path = join(runDir, 'task-objective-lifecycle.json'),
      bytes = readFileSync(path, 'utf8'),
      original = JSON.parse(bytes)
    assert.equal(original.objectives[0].taskModeHistory.revisions.length, 4)
    for (const corrupt of [
      { ...original, schema_version: 2 },
      { ...original, active_task_id: 'wrong-task' },
      { ...original, attempts: original.attempts.slice(1) },
      {
        ...original,
        attempts: original.attempts.map(
          (attempt: Record<string, unknown>, index: number) =>
            index === 0 ? { ...attempt, attempt_id: 'wrong-attempt' } : attempt,
        ),
      },
    ]) {
      writeFileSync(path, JSON.stringify(corrupt))
      assert.throws(
        () => loadLiveSessionAuthorityStrict(runDir),
        /objective lifecycle/i,
      )
    }
    writeFileSync(path, bytes)
    rmSync(path)
    assert.throws(
      () => loadLiveSessionAuthorityStrict(runDir),
      /objective lifecycle/i,
    )
    writeFileSync(path, bytes)
    assert.notEqual(
      loadLiveSessionAuthorityStrict(runDir).taskContract.task_id,
      first,
    )
  }))

test('a postcommit installation failure reloads the accepted objective and its own allowance', (t) =>
  fixture(async (engine, runDir) => {
    const scope = engine.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    engine.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const mock = t.mock.method(engine, 'applyPreparedUserSubmission', () => {
      throw new Error('Fixture installation interrupted')
    })
    try {
      assert.throws(
        () =>
          engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route),
        /OBJECTIVE_RELOAD_REQUIRED/,
      )
    } finally {
      mock.mock.restore()
    }
    const committed = loadLiveSessionAuthorityStrict(runDir).taskContract
    assert.equal(committed.user_request, 'Explain fixture B')
    assert.throws(
      () => engine.admitUserSubmission({ userInput: 'continue' }, route),
      /OBJECTIVE_RELOAD_REQUIRED/,
    )
    const restored = await ChatEngine.restore(engine.getEngineRunId(), { model: 'deepseek-v4-flash-openrouter',
      task: 'Resume',
      projectRoot: scope.projectRoot,
    })
    assert.equal(
      restored.getTurnRuntimeSnapshot()!.durableObjective,
      'Explain fixture B',
    )
    assert.equal(
      restored.getTaskAllowanceSnapshot()!.acceptedTaskId,
      committed.task_id,
    )
  }))

for (const budget of ['missing', 'mismatched'])
  test(`cells resume with ${budget} accounting cannot turn continuation into a new task`, () =>
    fixture((engine, runDir) => {
      const scope = engine.getExecutionScope()
      if (scope.kind !== 'project') throw new Error('Project fixture required')
      engine.admitUserSubmission(
        { userInput: 'Fix fixture A and run its tests' },
        route,
      )
      const oldBudget = readFileSync(join(runDir, 'task-budget.json'), 'utf8')
      engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
      const accepted = engine.getTaskContract()!
      if (budget === 'missing') rmSync(join(runDir, 'task-budget.json'))
      else writeFileSync(join(runDir, 'task-budget.json'), oldBudget)
      const resumed = createEngineFromThreadCells(
        engine.getEngineRunId(),
        { model: 'deepseek-v4-flash-openrouter',
          task: 'Resume fixture',
          projectRoot: scope.projectRoot,
        },
        [],
      )
      assert.equal(resumed.getTaskAllowanceSnapshot(), null)
      const files = new Map(
        readdirSync(runDir)
          .filter((name) => lstatSync(join(runDir, name)).isFile())
          .map((name) => [name, readFileSync(join(runDir, name), 'utf8')]),
      )
      assert.throws(
        () => resumed.admitUserSubmission({ userInput: 'continue' }, route),
        /OBJECTIVE_BUDGET_UNAVAILABLE/,
      )
      assert.equal(
        resumed.getTurnRuntimeSnapshot()!.durableObjective,
        'Explain fixture B',
      )
      assert.equal(
        resumed.getTaskContract()!.contract_hash,
        accepted.contract_hash,
      )
      assert.equal(resumed.getTaskAllowanceSnapshot(), null)
      assert.deepEqual(
        readdirSync(runDir).filter((name) =>
          lstatSync(join(runDir, name)).isFile(),
        ),
        [...files.keys()],
      )
      for (const [name, bytes] of files)
        assert.equal(readFileSync(join(runDir, name), 'utf8'), bytes)
      resumed.admitUserSubmission(
        { userInput: 'Explain independent fixture C' },
        route,
      )
      assert.notEqual(resumed.getTaskContract()!.task_id, accepted.task_id)
    }))

test('an old allowance and verification cannot become the new objective after restart', () =>
  fixture(async (engine, runDir) => {
    const scope = engine.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    engine.admitUserSubmission(
      { userInput: 'Fix fixture A and run its tests' },
      route,
    )
    const priorBudget = readFileSync(join(runDir, 'task-budget.json'), 'utf8')
    recordVerifierAttempt(engine.getParityRuntime().sessionEvents, {
      turn_id: engine.getParityRuntime().turnId!,
      command_preview: 'node --test fixture-a.test.mjs',
      authoritative: true,
      exit_code: 1,
    })
    engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
    assert.equal(
      engine.getLiveSession().verifier.attempts,
      0,
      'Prior objective verification must remain historical',
    )
    writeFileSync(join(runDir, 'task-budget.json'), priorBudget)
    const restored = await ChatEngine.restore(engine.getEngineRunId(), { model: 'deepseek-v4-flash-openrouter',
      task: 'Resume',
      projectRoot: scope.projectRoot,
    })
    assert.equal(
      restored.getTurnRuntimeSnapshot()!.durableObjective,
      'Explain fixture B',
    )
    assert.equal(restored.getTaskAllowanceSnapshot(), null)
    assert.equal(
      readFileSync(join(runDir, 'task-budget.json'), 'utf8'),
      priorBudget,
    )
    assert.throws(
      () => restored.admitUserSubmission({ userInput: 'continue' }, route),
      /OBJECTIVE_BUDGET_UNAVAILABLE/,
    )
    assert.equal(
      readFileSync(join(runDir, 'task-budget.json'), 'utf8'),
      priorBudget,
    )
  }))

test('independent objectives and their first attempts commit together before execution', () =>
  fixture(async (engine, runDir) => {
    assert.equal(
      typeof engine.admitUserSubmission,
      'function',
      'Atomic objective admission is required',
    )
    const scope = engine.getExecutionScope()
    if (scope.kind !== 'project') throw new Error('Project fixture required')
    engine.getParityRuntime().liveAuthority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: scope.projectRoot,
      task: 'Fix fixture A and run its tests',
      verifierRequirements: ['node --test fixture-a.test.mjs'],
    })
    const original = engine.getTaskContract()!,
      originalBytes = JSON.stringify(original),
      route = { model: 'fixture-model', provider: 'ollama' }
    engine.admitUserSubmission({ userInput: original.user_request }, route)
    const first = engine.getTaskContract()!
    const originalAllowanceOwner =
      engine.getTaskAllowanceSnapshot()!.taskOwnerId
    assert.equal(first.task_id, original.task_id)
    for (const text of ['status?', 'continue']) {
      engine.admitUserSubmission({ userInput: text }, route)
      assert.equal(engine.getTaskContract()!.contract_id, first.contract_id)
      assert.equal(
        engine.getTaskAllowanceSnapshot()!.taskOwnerId,
        originalAllowanceOwner,
        'A new attempt must not reset the objective allowance',
      )
    }
    engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
    const next = engine.getTaskContract()!
    assert.notEqual(next.task_id, first.task_id)
    assert.equal(next.user_request, 'Explain fixture B')
    assert.deepEqual(next.verifier_requirements, [])
    assert.equal(JSON.stringify(original), originalBytes)
    const lifecycle = JSON.parse(
      readFileSync(join(runDir, 'task-objective-lifecycle.json'), 'utf8'),
    )
    assert.equal(lifecycle.objectives.length, 2)
    assert.equal(lifecycle.attempts.length, 4)
    assert.equal(
      lifecycle.objectives[0].taskContract.contract_hash,
      first.contract_hash,
    )
    assert.equal(
      lifecycle.objectives[0].taskModeHistory?.revisions[0].contract_hash,
      original.contract_hash,
      'The published frozen seed must remain retained',
    )
    const latest = engine
      .getParityEventLog()
      .events.filter((event) => event.kind === 'turn_started')
      .at(-1)!
    assert.equal(latest.kind, 'turn_started')
    if (latest.kind !== 'turn_started')
      throw new Error('Canonical attempt required')
    assert.equal(latest.task_id, next.task_id)
    assert.equal(latest.contract_hash, next.contract_hash)
    assert.notEqual(latest.attempt_id, latest.turn_id)
    assert.equal(
      loadLiveSessionAuthorityStrict(runDir).taskContract.contract_hash,
      next.contract_hash,
    )
    const restored = await ChatEngine.restore(engine.getEngineRunId(), { model: 'deepseek-v4-flash-openrouter',
      task: 'Resume',
      projectRoot: scope.projectRoot,
    })
    assert.equal(
      restored.getTurnRuntimeSnapshot()!.durableObjective,
      'Explain fixture B',
    )
    assert.equal(restored.getTaskContract()!.task_id, next.task_id)
    engine.admitUserSubmission({ userInput: 'Explain fixture B' }, route)
    assert.notEqual(engine.getTaskContract()!.task_id, next.task_id)
  }))
