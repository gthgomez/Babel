/**
 * Repository context is captured at the real ChatEngine provider boundary.
 * Fixture writes model completed edits and invoke the real post-edit check;
 * these tests do not cover mutation authorization or provider HTTP transport.
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ChatEngineStreamingLoopHost } from './chatEngine.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import {
  isSyntheticProviderFixtureReady,
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

const childTestCount = 10

if (!isSyntheticProviderFixtureReady()) {
  test('repo-map refresh is isolated in a synthetic-only subprocess', { timeout: 30_000 }, async t => {
    const fixture = prepareSyntheticProviderFixture()
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test-reporter=tap', '--test', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const childDone = new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL')
      await childDone
      removeSyntheticProviderFixture(fixture.root)
    })
    const code = await childDone
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    const failedCases = [...output.matchAll(/^not ok \d+ - ((?:native|legacy): [\w ,.-]+)$/gm)]
      .map(match => match[1])
    if (failedCases.length) t.diagnostic(JSON.stringify({ failedCases }))
    // Project only fixture assertion labels, never arbitrary child output.
    const knownFailures = [
      'refreshed map reaches provider boundary', 'obsolete map is absent',
      'invalidated rendered prompt omits obsolete map', 'superseded submission cannot dispatch',
      'superseded preparation cannot begin execution',
    ].filter(label => output.includes(label))
    if (knownFailures.length) t.diagnostic(JSON.stringify({ assertionFailures: knownFailures }))
    assert.equal(code, 0, 'isolated ChatEngine regression must pass')
    const summary = JSON.parse(diagnostic) as { tests: number; passed: number; failed: number; skipped: number }
    assert.equal(summary.tests, childTestCount)
    assert.equal(summary.passed, childTestCount)
    assert.equal(summary.failed, 0)
    assert.equal(summary.skipped, 0)
  })
} else {
  const { ChatEngine } = await import('./chatEngine.js')
  const { prepareStreamingSubmission } = await import('./chatEngineStreamingPreparation.js')
  type Mode = 'native' | 'legacy' | 'text'
  type Dispatch = { system: string; conversation: string }
  type Internals = {
    generateRepoMap: () => Promise<string>
    runPostEditStaticCheck: (path: string) => Promise<string | null>
    getOrBuildSystemPrompt: (mode: Mode) => string
    beginActiveExecution: () => void
  }

  function deferred<T>() {
    let resolvePromise!: (value: T) => void
    let startPromise!: () => void
    return {
      promise: new Promise<T>(resolve => { resolvePromise = resolve }),
      started: new Promise<void>(resolve => { startPromise = resolve }),
      resolve: (value: T) => resolvePromise(value),
      markStarted: () => startPromise(),
    }
  }

  const drain = async (stream: AsyncGenerator<unknown, void, undefined>) => {
    for await (const _event of stream) { /* consume */ }
  }

  function makeFixture(t: TestContext, mode: Mode) {
    const root = mkdtempSync(join(tmpdir(), 'babel-repo-map-cache-'))
    const projectRoot = join(root, 'workspace')
    const runsRoot = join(root, 'runs')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    mkdirSync(runsRoot)
    const target = join(projectRoot, 'src', 'target.js')
    writeFileSync(target, 'export const value = 0\n')
    process.env['BABEL_RUNS_DIR'] = runsRoot
    process.env['BABEL_CHAT_MAX_COST'] = 'unlimited'
    process.env['BABEL_TOOL_PROFILE'] = mode === 'text' ? 'text' : 'legacy'
    const dispatches: Dispatch[] = []
    const rawRunner = {
      executeRawStream: async function* (prompt: string, system: string) {
        dispatches.push({ system, conversation: prompt })
        yield JSON.stringify({ type: 'completion', answer: 'Fixture inspection complete.' })
      },
      executeRaw: async () => 'Fixture inspection complete.',
      execute: async () => ({ type: 'completion', answer: 'Fixture inspection complete.' }),
      getLastInvocationMetadata: () => null,
    }
    const runner = mode === 'native' ? {
      ...rawRunner,
      executeWithToolsStream: async function* (messages: unknown[], _tools: unknown, system: string) {
        dispatches.push({ system, conversation: JSON.stringify(messages) })
        yield { type: 'text_delta' as const, text: 'Fixture inspection complete.' }
        yield { type: 'done' as const, finishReason: 'stop' as const }
      },
    } : rawRunner
    const policy: ResolvedModelPolicy = {
      policyPath: 'synthetic-fixture', family: 'fixture', selectedTier: 'cheap',
      resolvedBackendKey: 'fixture', provider: 'opencode-go', providerModelId: 'fixture-model',
      expensive: false, enabled: true, experimental: true, blockedWithoutExplicitOptIn: false,
      approximateInputTokens: 0, approximateOutputTokens: 0, warnings: [], waterfall: [],
      stagePolicies: [], contextWindow: 128_000, contextLimit: 128_000,
      maxOutputTokens: 1_024, nativeToolUse: mode === 'native',
    }
    const engine = new ChatEngine({
      task: 'Explain the fixture source without changing it.', projectRoot,
      // Initial request plus both continued fallback requests need three turns.
      runId: `repo-map-cache-${mode}`, model: 'fixture-model', maxTurns: 4,
      executionProfile: 'chat', providerRunner: runner as never, providerPolicy: policy,
    })
    t.after(() => {
      engine.closeAdmissionStore()
      rmSync(root, { recursive: true, force: true })
      delete process.env['BABEL_TOOL_PROFILE']
    })
    const internals = engine as unknown as Internals
    let writes = 0
    const edit = async () => {
      writes += 1
      writeFileSync(target, `export const value = ${writes}\n`)
      await internals.runPostEditStaticCheck(target)
    }
    return { engine, internals, dispatches, edit }
  }

  function assertMap(dispatch: Dispatch | undefined, current: string, obsolete: string[]) {
    assert.ok(dispatch, 'submission reaches provider boundary')
    assert.equal(dispatch.system.includes(current), true, 'refreshed map reaches provider boundary')
    for (const marker of obsolete) {
      assert.equal(dispatch.system.includes(marker), false, 'obsolete map is absent')
    }
  }

  for (const mode of ['native', 'legacy'] as const) {
    test(`${mode}: initial, fresh and continued requests await maps after completed edits`, { timeout: 10_000 }, async t => {
      const { engine, internals, dispatches, edit } = makeFixture(t, mode)
      internals.generateRepoMap = async () => 'FIXTURE_MAP_INITIAL'
      await drain(engine.submitMessageStream('Inspect the initial target source.', 'explain'))
      assert.equal(dispatches.length, 1)
      assertMap(dispatches[0], 'FIXTURE_MAP_INITIAL', [])

      for (const continueTask of [false, true]) {
        await edit()
        const marker = continueTask ? 'FIXTURE_MAP_CONTINUED' : 'FIXTURE_MAP_FRESH'
        const map = deferred<string>()
        internals.generateRepoMap = async () => { map.markStarted(); return map.promise }
        const userInput = continueTask ? 'Continue inspecting the updated source.' : 'Inspect the updated source as a fresh task.'
        const previousDispatches: number = dispatches.length
        const run = drain(engine.submitMessageStream(userInput, 'explain', { continueTask }))
        await Promise.race([map.started, run.then(() => { throw new Error('submission ended before map preparation') })])
        assert.equal(dispatches.length, previousDispatches, 'pending map prevents dispatch')
        map.resolve(marker)
        await run
        assert.equal(dispatches.length, previousDispatches + 1)
        assertMap(dispatches.at(-1), marker, ['FIXTURE_MAP_INITIAL', ...(continueTask ? ['FIXTURE_MAP_FRESH'] : [])])
        assert.equal(dispatches.at(-1)!.conversation.includes(userInput), true)
      }
    })

    test(`${mode}: rejected and empty optional maps cannot reuse context from a completed edit`, { timeout: 10_000 }, async t => {
      const { engine, internals, dispatches, edit } = makeFixture(t, mode)
      const task = 'Inspect the target source.'
      internals.generateRepoMap = async () => 'FIXTURE_MAP_OBSOLETE'
      await drain(engine.submitMessageStream(task, 'explain'))
      assertMap(dispatches[0], 'FIXTURE_MAP_OBSOLETE', [])
      for (const rejected of [true, false]) {
        await edit()
        internals.generateRepoMap = async () => {
          if (rejected) throw new Error('fixture optional map unavailable')
          return ''
        }
        await drain(engine.submitMessageStream(task, 'explain', { continueTask: true }))
        assert.equal(dispatches.at(-1)!.system.includes('FIXTURE_MAP_OBSOLETE'), false, 'obsolete map is absent')
      }
      assert.equal(dispatches.length, 3)
    })

    test(`${mode}: retained compaction capsule survives refreshed preparation`, { timeout: 10_000 }, async t => {
      const { engine, internals, dispatches, edit } = makeFixture(t, mode)
      internals.generateRepoMap = async () => 'FIXTURE_MAP_BEFORE_CAPSULE'
      await drain(engine.submitMessageStream('Inspect the target source.', 'explain'))
      const capsule = { role: 'system' as const, name: 'compaction_capsule', content: 'Fixture durable capsule', provenance: 'controller' as const, authoritative: true }
      engine.replaceConversation([capsule])
      await edit()
      const map = deferred<string>()
      internals.generateRepoMap = async () => { map.markStarted(); return map.promise }
      const preparing = prepareStreamingSubmission(engine as unknown as ChatEngineStreamingLoopHost, 'Continue inspecting the target source.', 'explain', { continueTask: true })
      await map.started
      map.resolve('FIXTURE_MAP_AFTER_CAPSULE')
      const prepared = await preparing
      assert.equal(prepared.halted, false)
      const retained = engine.getConversation().find(message => message.name === 'compaction_capsule')
      assert.equal(retained, capsule)
      assert.equal(retained?.content, 'Fixture durable capsule')
      assert.equal(internals.getOrBuildSystemPrompt(mode).includes('FIXTURE_MAP_AFTER_CAPSULE'), true)
      assert.equal(dispatches.length, 1, 'capsule case exercises preparation without claiming P11 dispatch')
    })

    test(`${mode}: superseded retained-system preparation cannot dispatch or replace current context`, { timeout: 10_000 }, async t => {
      const { engine, internals, dispatches, edit } = makeFixture(t, mode)
      internals.generateRepoMap = async () => 'FIXTURE_MAP_INITIAL'
      await drain(engine.submitMessageStream('Inspect the initial source.', 'explain'))
      await edit()
      let executionStarts = 0
      const originalBegin = internals.beginActiveExecution.bind(engine)
      internals.beginActiveExecution = () => { executionStarts += 1; originalBegin() }
      const oldMap = deferred<string>()
      const newMap = deferred<string>()
      let mapCalls = 0
      internals.generateRepoMap = async () => {
        const map = ++mapCalls === 1 ? oldMap : newMap
        map.markStarted()
        return map.promise
      }
      const oldRun = drain(engine.submitMessageStream('Inspect the superseded source task.', 'explain'))
      await oldMap.started
      assert.equal(executionStarts, 0, 'superseded preparation cannot begin execution')
      const currentRun = drain(engine.submitMessageStream('Inspect the current source task.', 'explain'))
      await newMap.started
      newMap.resolve('FIXTURE_MAP_CURRENT')
      await currentRun
      oldMap.resolve('FIXTURE_MAP_SUPERSEDED')
      await oldRun
      assert.equal(dispatches.length, 2, 'superseded submission cannot dispatch')
      assert.equal(executionStarts, 1)
      assertMap(dispatches[1], 'FIXTURE_MAP_CURRENT', ['FIXTURE_MAP_INITIAL', 'FIXTURE_MAP_SUPERSEDED'])
      assert.equal(internals.getOrBuildSystemPrompt(mode).includes('FIXTURE_MAP_SUPERSEDED'), false)
    })
  }

  test('completed edit invalidates all rendered prompt modes before another submission', { timeout: 10_000 }, async t => {
    const { engine, internals, edit } = makeFixture(t, 'native')
    internals.generateRepoMap = async () => 'FIXTURE_MAP_OBSOLETE'
    await drain(engine.submitMessageStream('Inspect the target source.', 'explain'))
    for (const mode of ['native', 'legacy', 'text'] as const) internals.getOrBuildSystemPrompt(mode)
    await edit()
    for (const mode of ['native', 'legacy', 'text'] as const) {
      assert.equal(internals.getOrBuildSystemPrompt(mode).includes('FIXTURE_MAP_OBSOLETE'), false, 'invalidated rendered prompt omits obsolete map')
    }
  })

  test('text tools retain deliberate omission of optional repository context', { timeout: 10_000 }, async t => {
    const { engine, internals, dispatches } = makeFixture(t, 'text')
    internals.generateRepoMap = async () => 'FIXTURE_MAP_OPTIONAL'
    await drain(engine.submitMessageStream('Inspect the target source.', 'explain'))
    assert.equal(dispatches.length, 1)
    assert.equal(dispatches[0]!.system.includes('FIXTURE_MAP_OPTIONAL'), false)
  })
}
