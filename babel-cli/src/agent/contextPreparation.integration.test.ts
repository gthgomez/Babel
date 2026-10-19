import { buildCausalAttributionReport } from '../services/causalAttribution.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { openAdmissionStore } from '../runtime/admission.js'
import { consumeChatStream, buildChatRunPayload } from '../interactive/execution/chatCore.js'
import { loadSessionEventLogFromDir } from './sessionEvents.js'
import { validateColdResume } from '../runtime/contextCheckpoints.js'

for (const selected of ['umbrella', 'nested', 'non-git', 'missing-state'] as const) {
  test(`admitted ${selected} root continues without repository certification or refuses missing operational state`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'babel-context-preparation-'))
    const project = join(root, 'workspace'); mkdirSync(project)
    const nested = join(project, 'products', 'current-app'); mkdirSync(nested, { recursive: true })
    for (const dir of [project, nested]) {
      const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true })
      writeFileSync(join(dir, 'ui.txt'), 'Source evidence for the current app.\n')
      git(['init', '-q']); git(['add', 'ui.txt'])
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    }
    writeFileSync(join(project, 'unrelated.apk'), ''); truncateSync(join(project, 'unrelated.apk'), 1_000_001)
    const runRoot = join(root, 'runs'); mkdirSync(runRoot)
    const priorRuns = process.env['BABEL_RUNS_DIR']; process.env['BABEL_RUNS_DIR'] = runRoot
    t.after(() => { if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = priorRuns })
    const opened = openAdmissionStore({ authorizedRoot: root, runDir: runRoot })
    assert.ok(opened.ok); if (!opened.ok) return
    t.after(() => { opened.store.close(); rmSync(root, { recursive: true, force: true }) })
    const plain = join(root, 'plain'); mkdirSync(plain); writeFileSync(join(plain, 'ui.txt'), 'Plain source evidence.')
    const projectRoot = selected === 'nested' ? nested : selected === 'non-git' ? plain : project
    const engine = new ChatEngine({ task: 'Research the current app UI.', projectRoot, admissionStore: opened.store, model: 'deepseek-v4-flash', maxTurns: 3 })
    let dispatches = 0
    const runner = {
      executeWithToolsStream: async function* (): AsyncGenerator<ToolStreamEvent, void, undefined> {
        dispatches++
        if (dispatches === 1) { yield { type: 'tool_use', id: 'source-range', name: 'read_range', input: { file_path: 'ui.txt', start_line: 1, end_line: 1 } }; yield { type: 'done', finishReason: 'tool_calls' } }
        else { yield { type: 'text_delta', text: 'The inspected source is the current app. Visual interaction checks were not performed.' }; yield { type: 'done', finishReason: 'stop' } }
      },
      execute: async () => ({ type: 'completion', answer: 'Inspected source.' }), executeRaw: async () => 'Inspected source.', getLastInvocationMetadata: () => null,
    }
    Object.assign(engine, { deliberationRunner: runner, synthesisRunner: runner, shouldUseNativeTools: () => true })
    if (selected === 'missing-state') Object.assign(engine, { buildP11Sources: () => null })
    const result = await consumeChatStream(engine.submitMessageStream('Research the current app UI.', 'explain'), null)
    if (selected === 'missing-state') {
      assert.equal(dispatches, 0)
      assert.equal(result.reason_code, 'context_preparation_failed')
      assert.equal(result.cause_class, 'harness')
      assert.match(result.answer, /operational state is unavailable/)
      assert.equal(engine.getParityEventLog().events.some(event => event.kind === 'compaction_capsule'), false)
      const payload = buildChatRunPayload(result, { task: 'Research UI', projectRoot })
      assert.equal(payload['terminal_outcome'], 'BLOCKED_POLICY')
      const why = buildCausalAttributionReport({ log: engine.getParityRuntime().sessionEvents })
      assert.equal(why.reason_code, 'context_preparation_failed')
      assert.equal(why.cause_class, 'harness')
      assert.equal(why.attribution.code, 'context_preparation_failed')
      const events = loadSessionEventLogFromDir(result.runDir!)!.events
      const terminal = [...events].reverse().find(event => event.kind === 'turn_ended')
      assert.equal(terminal?.kind === 'turn_ended' ? terminal.reason_code : null, result.reason_code)
    } else {
      assert.equal(dispatches, 2)
      assert.match(result.answer, /Visual interaction checks were not performed/)
      assert.ok(engine.getParityRuntime().contextCheckpoint)
      assert.equal(engine.getParityRuntime().contextCheckpoint?.schema_version, 2)
      assert.equal(engine.getParityRuntime().contextCheckpoint?.workspace, null)
      assert.equal(engine.getParityRuntime().contextCheckpoint?.population.workspace_revision_current, false)
      assert.ok(engine.getParityRuntime().sessionEvents.events.some(event => event.kind === 'tool_completed' && event.tool_call_id === 'source-range'))
      const parity = engine.getParityRuntime()
      const checkpoint = parity.contextCheckpoint
      assert.ok(checkpoint)
      assert.equal(checkpoint.observation_manifest.length, 1)
      assert.ok(checkpoint.observation_manifest.every(observation => !observation.snapshot_ref && !observation.coverage_ref))
      const membership = [...(parity.authorizedObservationIds ?? [])]
      const resumeInput = { checkpoint, currentOwner: opened.store.readOwner(checkpoint.threadId),
        lineageEvidence: { threadEvents: parity.eventLog.events, sessionEvents: parity.sessionEvents.events } }
      assert.equal(validateColdResume({ ...resumeInput, authorizedObservationIds: membership }).status, 'ready')
      assert.equal(validateColdResume({ ...resumeInput, authorizedObservationIds: [] }).status, 'blocked')
      assert.equal(validateColdResume(resumeInput).status, 'blocked')
    }
  })
}
