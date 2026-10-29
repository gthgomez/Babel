import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { SafeExecutor } from '../sandbox.js'
import { unsupportedTestClaim, unsupportedMutationClaim, responseEvidenceCorrection, isPunctuationOnlyAnswer } from './chatResponseEvidence.js'

test('punctuation-only evidence correction cannot masquerade as a delivered answer', () => {
  for (const answer of ['.', '...', ' — ', '  !  ']) assert.equal(isPunctuationOnlyAnswer(answer), true)
  for (const answer of ['No.', 'Updated README.md.', '0 tests ran.']) assert.equal(isPunctuationOnlyAnswer(answer), false)
})

test('test claims distinguish execution, freshness, result and scope', () => {
  const green = { command: 'npm test', exit_code: 0, authority: true, stale: false, scope: 'full_suite', tests_total: 1, tests_skipped: 0 }
  for (const text of ['The baseline test passes.', 'All tests passed.', 'I ran npm test.', 'npm test → exit code 0']) {
    assert.equal(unsupportedTestClaim(text, null), true, text)
    assert.equal(unsupportedTestClaim(text, green), false, text)
  }
  assert.equal(unsupportedTestClaim('I ran npm test; it failed.', { ...green, exit_code: 1 }), false)
  assert.equal(unsupportedTestClaim('I ran npm test successfully.', { ...green, exit_code: 1 }), true)
  assert.equal(unsupportedTestClaim('The baseline test passes.', { ...green, stale: true }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, scope: 'targeted' }), true)
  assert.equal(unsupportedTestClaim('I ran pytest.', green), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, authority: false }), true)
  assert.equal(unsupportedTestClaim('npm test passed.', { ...green, command: 'npm test -- math.test.js', scope: 'targeted' }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, tests_total: 0 }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, tests_total: 2, tests_skipped: 2 }), true)
  const pytest = { ...green, command: 'pytest' }
  assert.equal(unsupportedTestClaim('npm test passed. I ran pytest.', pytest, [green, pytest]), false)
  assert.equal(unsupportedTestClaim('npm test passed.', { ...green, exit_code: 1 }, [green]), true)
  const typecheck = { command: 'tsc --noEmit', exit_code: 0, authority: true, stale: false, scope: 'full_suite' }
  assert.equal(unsupportedTestClaim('All tests passed.', typecheck, [green, typecheck]), false)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...typecheck, command: 'npm run typecheck' }, [green]), false)
  const fullGreen = { ...green, capturedAt: 3 }
  const oldTargetRed = { ...green, command: 'npm test -- math.test.js', scope: 'targeted', exit_code: 1, capturedAt: 2 }
  const laterPytest = { ...pytest, capturedAt: 4 }
  assert.equal(unsupportedTestClaim('All tests passed.', laterPytest, [fullGreen, oldTargetRed, laterPytest]), false)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...oldTargetRed, capturedAt: 5 }, [fullGreen, laterPytest]), true)
  for (const text of ['Run npm test.', 'Tests should pass.', 'I have not run tests.',
    'If tests pass, continue.', 'Verify that tests pass.', 'I cannot say the tests pass.', 'No tests passed.',
    'The test passes if the value is 5.', 'The test passes when input is empty.',
    'Did the tests pass?', 'Do tests pass?', 'Make sure tests pass.', 'Next, ensure that tests pass.',
    'You can verify that tests pass.',
    'The README says "tests pass".', '> All tests passed.\nThat is a quotation.',
    '```text\nAll tests passed.\n```', '{"flow":"checkout -> subtotal -> tax","taxRate":0.1,"testCommand":"npm test"}'])
    assert.equal(unsupportedTestClaim(text, null), false, text)
})

test('explicit targeted test reports retain their selectors without certifying the whole suite', () => {
  for(const command of ['npm test -- math.test.js','node --test math.test.js','pytest tests/math.py','go test ./math','cargo test addition']) {
    const green={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0}
    assert.equal(unsupportedTestClaim(`I ran \`${command}\`.`,green),false,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,green),false,command)
    assert.equal(unsupportedTestClaim(`I ran \`${command}\`; it failed.`,{...green,exit_code:1}),false,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,{...green,exit_code:1}),true,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,{...green,stale:true}),true,command)
    assert.equal(unsupportedTestClaim('All tests passed.',green),true,command)
  }
  const receipt={command:'npm test -- math.test.js',exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1}
  assert.equal(unsupportedTestClaim('I ran `npm test -- other.test.js`.',receipt),true)
  assert.equal(unsupportedTestClaim('`npm test` passed.',receipt),true)
})

test('bare targeted reports preserve selectors and separate prose success from filename periods', () => {
  for(const command of ['npm test -- math.test.js','node --test math.test.js','pytest tests/math.py','go test ./math','cargo test addition']) {
    const green={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0}
    for(const text of [`I ran ${command}.`,`${command} passed.`,`I ran ${command} and it failed.`])
      assert.equal(unsupportedTestClaim(text,green),false,text)
    for(const text of [`${command} passed.`,`I ran ${command}.`]) {
      assert.equal(unsupportedTestClaim(text,null),true,text)
      assert.equal(unsupportedTestClaim(text,{...green,command:command.replace(/math|addition/g,'different')}),true,text)
    }
    for(const text of [`I ran ${command} successfully.`,`I ran \`${command}\` successfully.`,`${command} passed.`])
      assert.equal(unsupportedTestClaim(text,{...green,exit_code:1}),true,text)
  }
  const command='pytest -k "with tax" tests/passed.test.py';
  const receipt={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0};
  assert.equal(unsupportedTestClaim(`I ran ${command} and it passed.`,receipt),false);
  assert.equal(unsupportedTestClaim(`I ran ${command} and it passed.`,{...receipt,exit_code:1}),true);
  assert.equal(unsupportedTestClaim('I ran npm test and it failed.',{...receipt,command:'npm test',exit_code:1}),false);
})

for (const scenario of ['correction', 'repeated', 'exact_json', 'mutation-correction', 'mutation-repeated', 'mixed-repeated', 'punctuation-correction', 'punctuation-repeated', 'punctuation-final', 'evidence-final'] as const)
test(`response evidence ${scenario}: preserve useful answers without requiring effects`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-response-evidence-'))
  const prior = process.env['BABEL_NATIVE_TOOLS']
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  t.after(() => {
    if (prior === undefined) delete process.env['BABEL_NATIVE_TOOLS']; else process.env['BABEL_NATIVE_TOOLS'] = prior
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(join(root, 'catalog.js'), 'export const orderCatalog = items => [...items]\n')
  let effects = 0
  const forbidden = () => { effects++; throw new Error('No effects are needed to clarify') }
  t.mock.method(SafeExecutor.prototype, 'shellExec', forbidden)
  t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => forbidden())
  t.mock.method(SafeExecutor.prototype, 'fileWrite', forbidden)
  const corrected = 'I inspected the implementation; I have not run tests. Which ordering do you want: price, name, or popularity?'
  const unsupported = scenario.startsWith('mutation-')
    ? 'The repository map was updated. Which ordering do you want: price, name, or popularity?'
    : 'The baseline test passes. Which ordering do you want: price, name, or popularity?'
  const exact = '{"flow":"catalog returns an input copy","testCommand":"npm test"}'
  class Runner extends DeepInfraApiRunner {
    turns = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turns++
      if (this.turns === 1) {
        yield { type: 'tool_use', id: 'inspect-catalog', name: 'read_file', input: { path: 'catalog.js' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        const text = scenario.startsWith('punctuation-')
          ? this.turns === 2 ? unsupported : this.turns === 3 || scenario === 'punctuation-repeated' ? '.' : corrected
          : scenario === 'mixed-repeated' && this.turns > 2 ? 'I updated files.' : scenario === 'exact_json' ? exact :
            scenario.endsWith('repeated') || this.turns === 2 ? unsupported : corrected
        yield { type: 'text_delta', text }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const runner = new Runner()
  const engine = new ChatEngine({ task: 'Make this better.', projectRoot: root,
    model: 'deepseek-v4-flash', providerRunner: runner, maxTurns: scenario === 'punctuation-final' ? 3 : scenario === 'evidence-final' ? 2 : 6 })
  let answer = ''
  let failure: { reason_code?: string; outcome?: string } | undefined
  for await (const event of engine.submitMessageStream('Make this better.', 'execute')) {
    if (event.type === 'done') answer = event.answer
    if (event.type === 'failed') failure = event
  }
  if (scenario.endsWith('repeated') || scenario === 'punctuation-final' || scenario === 'evidence-final') {
    assert.equal(failure?.reason_code, 'response_evidence_invalid')
    assert.equal(failure?.outcome, 'AGENT_FAILURE')
  } else assert.equal(answer, scenario === 'exact_json' ? exact : corrected)
  assert.equal(runner.turns, scenario === 'exact_json' ? 2 : scenario === 'evidence-final' ? 2 : scenario === 'punctuation-final' ? 3 : scenario.startsWith('punctuation-') ? 4 : 3)
  assert.equal(effects, 0)
  assert.equal(readFileSync(join(root, 'catalog.js'), 'utf8'), 'export const orderCatalog = items => [...items]\n')
})

for (const cancelAtFinalCorrection of [false, true]) {
test(`ChatEngine preserves read-back artifact after failed evidence correction (cancel=${cancelAtFinalCorrection})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-response-artifact-fallback-'))
  const previous = process.env['BABEL_NATIVE_TOOLS']
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  t.after(() => {
    if (previous === undefined) delete process.env['BABEL_NATIVE_TOOLS']
    else process.env['BABEL_NATIVE_TOOLS'] = previous
    rmSync(root, { recursive: true, force: true })
  })
  let engine: ChatEngine
  class Runner extends DeepInfraApiRunner {
    private turn = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turn++
      if (this.turn === 1) {
        yield { type: 'tool_use', id: 'create-artifact', name: 'write_file', input: { path: 'result.txt', content: 'calculated result\n' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (this.turn === 2) {
        yield { type: 'tool_use', id: 'read-artifact', name: 'read_file', input: { path: 'result.txt' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (this.turn === 3) {
        yield { type: 'tool_use', id: 'run-tests', name: 'test_run', input: { command: 'npm test' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        if (cancelAtFinalCorrection && this.turn === 5) engine.cancel()
        yield { type: 'text_delta', text: 'All tests passed.' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const runner = new Runner()
  engine = new ChatEngine({ task: 'Fix the result formatting.', projectRoot: root,
    model: 'deepseek-v4-flash', providerRunner: runner, maxTurns: 7 })
  const internal = engine as unknown as { isolationBrokerFlags: () => unknown }
  internal.isolationBrokerFlags = () => ({ isolationRequired: true, isolationAvailable: false, hostFallbackAllowed: false, dirtyTree: false })
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream('Fix the result formatting.', 'execute')) events.push(event)
  const terminal = events.filter(event => event.type === 'failed' || event.type === 'cancelled' || event.type === 'done')
  assert.equal(terminal.length, 1)
  if (cancelAtFinalCorrection) {
    assert.equal(terminal[0]?.type, 'cancelled')
    assert.equal(events.some(event => event.type === 'failed' && /result\.txt/.test(event.error)), false)
  } else {
    assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'calculated result\n')
    assert.equal(terminal[0]?.type, 'failed')
    const failure = terminal[0] as Extract<ChatEvent, { type: 'failed' }>
    assert.equal(failure.outcome, 'AGENT_FAILURE')
    assert.match(failure.error, /UNVERIFIED/)
    assert.match(failure.error, /result\.txt/)
    assert.match(failure.error, /not certified/)
    assert.doesNotMatch(failure.error, /All tests passed/)
  }
})
}

test('ChatEngine final answer matches an unverified mutation terminal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-unverified-terminal-answer-'))
  const previous = {
    native: process.env['BABEL_NATIVE_TOOLS'],
    runs: process.env['BABEL_RUNS_DIR'],
    taskClass: process.env['BABEL_CHAT_TASK_CLASS'],
  }
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  process.env['BABEL_CHAT_TASK_CLASS'] = 'ordinary_delivery'
  t.after(() => {
    if (previous.native === undefined) delete process.env['BABEL_NATIVE_TOOLS']
    else process.env['BABEL_NATIVE_TOOLS'] = previous.native
    if (previous.runs === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previous.runs
    if (previous.taskClass === undefined) delete process.env['BABEL_CHAT_TASK_CLASS']
    else process.env['BABEL_CHAT_TASK_CLASS'] = previous.taskClass
    rmSync(root, { recursive: true, force: true })
  })

  const task = 'Create result.txt with exactly "calculated result" and report what verification you actually ran.'
  const modelAnswer = 'Fixed and verified.'
  class Runner extends DeepInfraApiRunner {
    private turn = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turn++
      if (this.turn === 1) {
        yield { type: 'tool_use', id: 'create-result', name: 'write_file', input: { path: 'result.txt', content: 'calculated result' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: modelAnswer }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const runner = new Runner()
  const engine = new ChatEngine({ task, projectRoot: root, model: 'deepseek-v4-flash', providerRunner: runner,
    maxTurns: 4 })
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream(task, 'execute')) events.push(event)
  const terminal = events.find(event => event.type === 'done')

  assert.equal(terminal?.type, 'done', JSON.stringify(events))
  if (terminal?.type !== 'done') return
  assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'calculated result')
  assert.equal(terminal.outcome, 'UNVERIFIED_PATCH')
  assert.match(terminal.answer, /^Completion status: UNVERIFIED_PATCH\./)
  assert.match(terminal.answer, /Completion status: UNVERIFIED_PATCH/)
  assert.match(terminal.answer, /required task-acceptance evidence was not established/i)
  assert.match(terminal.answer, /Paths with recorded confirmed mutations[^\n]*result\.txt/)
  assert.match(terminal.answer, /Unverified model response:[\s\S]*Fixed and verified\./)
  assert.doesNotMatch(terminal.answer, /No authoritative verifier result was recorded/i)
  assert.equal(engine.getConversation().at(-1)?.content, terminal.answer)
  const decisions = engine.getParityRuntime().sessionEvents.events.filter(event => event.kind === 'completion_decision')
  assert.equal(decisions.at(-1)?.final_outcome, 'UNVERIFIED_PATCH')
})

test('native numeric pass claims bind exact counts and targeted command identity', () => {
  const receipt = { command: 'node --test proof.cjs', exit_code: 0, authority: true, stale: false, scope: 'targeted', tests_total: 1, tests_skipped: 0, tests_passed: 1, tests_failed: 0 }
  const text = 'Created proof.cjs, read it, and ran node --test proof.cjs: 1 test passed in the configured sandbox.'
  assert.equal(unsupportedTestClaim(text, receipt), false)
  for (const bad of [null, { ...receipt, tests_passed: undefined }, { ...receipt, tests_passed: 2 }, { ...receipt, exit_code: 1 }, { ...receipt, stale: true }, { ...receipt, authority: false }])
    assert.equal(unsupportedTestClaim(text, bad), true)
  assert.equal(unsupportedTestClaim(text.replace('1 test', '2 tests'), { ...receipt, scope: 'full_suite' }), true)
  assert.equal(unsupportedTestClaim(text.replace('proof.cjs:', 'other.cjs:'), receipt), true)
  assert.equal(unsupportedTestClaim('All tests passed.', receipt), true)
})

test('numeric pass claims do not promote scope or substitute unrelated receipts', () => {
  const receipt = { command: 'node --test proof.cjs', exit_code: 0, authority: true, stale: false, scope: 'targeted', tests_total: 2, tests_skipped: 1, tests_passed: 1, tests_failed: 0 }
  assert.equal(unsupportedTestClaim('1 test passed.', receipt), true)
  for (const text of ['All 1 test passed.', 'The entire suite of 1 test passed.', 'The whole suite of 1 test passed.', 'All of the 1 tests passed.', '1 suite passed.', '1 test suite passed.', 'I ran node --test proof.cjs: 1 test passed across the entire suite.', 'I ran node --test proof.cjs: 1 test all passed.']) assert.equal(unsupportedTestClaim(text, receipt), true)
  assert.equal(unsupportedTestClaim('2 tests passed.', receipt), true)
  assert.equal(unsupportedTestClaim('1 test passed.', { ...receipt, tests_total: 0 }), true)
  assert.equal(unsupportedTestClaim('1 test passed.', { ...receipt, tests_failed: 1 }), true)
  assert.equal(unsupportedTestClaim('1 test passed.', receipt, [{ ...receipt, command: 'node --test other.cjs' }]), true)
  assert.equal(unsupportedTestClaim('No tests passed.', null), false)
  assert.equal(unsupportedTestClaim('If 1 test passed, continue.', null), false)
})

test('command literals do not become whole-suite scope claims', () => {
  for (const command of ['node --test all.test.cjs', 'node --test all']) {
    const receipt = { command, exit_code: 0, authority: true, stale: false, scope: 'targeted', tests_total: 1, tests_skipped: 0, tests_passed: 1, tests_failed: 0 }
    assert.equal(unsupportedTestClaim(`${command} passed.`, receipt), false)
    assert.equal(unsupportedTestClaim(`I ran ${command}: 1 test passed.`, receipt), false)
    assert.equal(unsupportedTestClaim(`I ran ${command}: 1 test passed across the entire suite.`, receipt), true)
  }
})


test('completed file-work claims require confirmed mutations, while inspected no-change remains truthful', () => {
  const claims = ['The repository map was updated.', 'I updated REPO_MAP.md.', 'I created proof.cjs.', 'I created a file.',
    'We have changed the code.', 'Updated the module.', 'I updated `REPO_MAP.md`.', '`REPO_MAP.md` was updated.', 'The file has been saved.']
  for (const answer of claims) {
    assert.equal(unsupportedMutationClaim(answer, false), true, answer)
    assert.equal(unsupportedMutationClaim(answer, true), false, answer)
  }
  for (const answer of ['The requested implementation was already correct; no changes were needed.',
    'I inspected the repository map. It already matches the current tree.', 'I have not updated files.',
    'I never updated the file.', 'No file was updated.', 'If I updated files, I would rerun tests.',
    'Have I updated files?', 'The file was updated?', 'Do you think the file was updated?',
    'I wrote code below.\n```js\nconsole.log(1)\n```', 'I created a patch in this answer.', 'Check whether the file was updated.', 'Please verify that the file was updated.',
    'The file was updated by another agent.', 'The file was updated before this task.',
    'The README says "I updated files".', '> The repository map was updated.',
    '```text\nI updated files.\n```', 'I updated my answer.', 'I changed my mind.'])
    assert.equal(unsupportedMutationClaim(answer, false), false, answer)
  assert.match(responseEvidenceCorrection(null, true), /No confirmed file mutation/)
  assert.doesNotMatch(responseEvidenceCorrection(null, true), /claims tests ran/)
  assert.match(responseEvidenceCorrection(null), /claims tests ran/)
  const countedOnly = { command: 'npm test', exit_code: 0, authority: true, stale: false,
    scope: 'full_suite', tests_total: 1, tests_skipped: 0 }
  const correction = responseEvidenceCorrection(countedOnly, false, 'I ran npm test: 1 test passed.')
  assert.match(correction, /confirms npm test executed/)
  assert.match(correction, /exact pass count is not recorded/)
  assert.match(correction, /retain.*file-change summary/i)
  assert.match(responseEvidenceCorrection(countedOnly, false, 'I ran pytest: 1 test passed.'), /Claims about other commands need their own matching evidence/)
  assert.match(responseEvidenceCorrection(countedOnly, false, 'I ran pytest: all tests passed.'), /claims tests ran or passed/)
  const zeroTests = { command: 'node --test', exit_code: 0, authority: true, stale: false,
    scope: 'full_suite', tests_total: 0, tests_skipped: 0 }
  const zeroCorrection = responseEvidenceCorrection(zeroTests, false, 'I ran npm test and all tests passed.')
  assert.match(zeroCorrection, /node --test/)
  assert.match(zeroCorrection, /zero tests/)
  assert.match(zeroCorrection, /other commands need their own matching evidence/)
  assert.match(zeroCorrection, /retain.*artifact summary/i)
})
