import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ChatEngine } from './chatEngine.js'
import { beginUserSubmission } from './turnRuntime.js'
import { filterReadOnlyChatTools } from './chatReadOnly.js'
import { buildChatToolDefinitions, buildChatSystemPrompt } from './chatToolDefinitions.js'
import { evaluateCompletionGateForEngine, hasInspectedNoChangeEvidence, type GateToolLogEntry } from './completionGatePolicy.js'
import { createExecutorKernel } from '../executor/kernel.js'
import { availableChatToolNames, availableChatTools } from './chatToolAvailability.js'

const dirs: string[] = []
const originalRuns = process.env['BABEL_RUNS_DIR']
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-explicit-operation-'))
  dirs.push(root)
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  writeFileSync(join(root, 'AGENTS.md'), 'Follow the requested scope.\n')
  return root
}
afterEach(() => {
  if (originalRuns === undefined) delete process.env['BABEL_RUNS_DIR']
  else process.env['BABEL_RUNS_DIR'] = originalRuns
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('caller READ_ONLY narrows mutation-shaped text before accepted operation and intent', () => {
  const next = beginUserSubmission({
    userInput: 'Fix the parser across modules.', projectRoot: '.',
    operation: 'READ_ONLY', classifyIntent: () => 'execute',
  })
  assert.equal(next.effectiveOperation, 'READ_ONLY')
  assert.equal(next.taskIntent, 'explain')
})

test('caller CHANGE resolves verb-less tasks without relying on mutation keywords', () => {
  const next = beginUserSubmission({
    userInput: 'Null input should return an empty list.', projectRoot: '.',
    operation: 'CHANGE', classifyIntent: () => 'explain',
  })
  assert.equal(next.effectiveOperation, 'MUTATING')
  assert.equal(next.taskIntent, 'execute')
  assert.equal(next.taskClass, 'default')
})

test('an explicit no-edit request remains narrowing even with caller CHANGE', () => {
  const next = beginUserSubmission({
    userInput: 'Do not modify anything. Explain the parser.', projectRoot: '.',
    operation: 'CHANGE', classifyIntent: () => 'execute',
  })
  assert.equal(next.effectiveOperation, 'READ_ONLY')
  assert.equal(next.taskIntent, 'explain')
})

test('explicit operation replaces a continued task operation, not its runtime grants', () => {
  const previous = beginUserSubmission({
    userInput: 'Fix the parser.', projectRoot: '.', classifyIntent: () => 'execute',
  })
  const next = beginUserSubmission({
    userInput: 'continue', projectRoot: '.', previous, continueTask: true,
    operation: 'READ_ONLY', classifyIntent: () => 'execute',
  })
  assert.equal(next.effectiveOperation, 'READ_ONLY')
  assert.equal(next.taskIntent, 'explain')
  const tools = filterReadOnlyChatTools(buildChatToolDefinitions(), { BABEL_READ_ONLY: 'true' })
  assert.ok(!tools.some(t => ['write_file', 'run_command', 'apply_patch'].includes(t.function.name)))
})

test('fresh and reused engines consume explicit operation and clear omitted overrides', () => {
  const root = fixture()
  const engine = new ChatEngine({ task: 'Fix the parser.', projectRoot: root, operation: 'READ_ONLY' })
  assert.equal(engine.applyUserSubmission({ userInput: 'Fix the parser.' }).effectiveOperation, 'READ_ONLY')
  engine.applyTurnPreparation({ task: 'Fix the parser.', projectRoot: root })
  assert.equal(engine.applyUserSubmission({ userInput: 'Fix the parser.' }).effectiveOperation, 'MUTATING')
})

test('all protocols retain caller policy and task verifier context once', () => {
  const engine = new ChatEngine({
    task: 'Fix the parser. Run `npm test` to verify the result.', projectRoot: fixture(),
    appendSystemPrompt: 'CALLER_POLICY: use only the authorized project.',
  })
  const promptHost = engine as unknown as { getOrBuildSystemPrompt(mode: 'native' | 'text' | 'legacy'): string }
  for (const mode of ['native', 'text', 'legacy'] as const) {
    const prompt = promptHost.getOrBuildSystemPrompt(mode)
    assert.equal(prompt.split('CALLER_POLICY:').length - 1, 1, mode)
    assert.match(prompt, /npm test/, mode)
  }
})

test('direct engines deliver complete required repository context and record that delivery', () => {
  const root = fixture()
  const contract = 'DIRECT_REPO_CONTRACT: preserve scope.\n' + 'x'.repeat(300) + '\nTAIL_REQUIRED_RULE'
  writeFileSync(join(root, 'AGENTS.md'), contract)
  const engine = new ChatEngine({ task: 'Explain the code.', projectRoot: root, systemContext: 'CALLER_CONTEXT' })
  const host = engine as unknown as { getOrBuildSystemPrompt(mode: 'native'): string }
  const prompt = host.getOrBuildSystemPrompt('native')
  assert.ok(prompt.includes(contract))
  assert.equal(prompt.split('DIRECT_REPO_CONTRACT:').length - 1, 1)
  const fragment = engine.getInstructionManifest()?.fragments.find(f => f.rule_id === 'identity:agents')
  assert.equal(fragment?.delivery_status, 'included')
  assert.equal(fragment?.included_chars, contract.length)
})

test('direct engines fail before dispatch when required policy cannot fit', () => {
  const root = fixture()
  writeFileSync(join(root, 'AGENTS.md'), 'required rule\n'.repeat(2000))
  assert.throws(() => new ChatEngine({ task: 'Explain the code.', projectRoot: root }), /required|mandatory|budget/i)
})

test('actual streamed read-only requests expose only their accepted task tools', async () => {
  let advertised: string[] = []
  const engine = new ChatEngine({ task: 'Fix the parser.', projectRoot: fixture(), operation: 'READ_ONLY' })
  const host = engine as unknown as {
    shouldUseNativeTools: () => boolean
    deliberationRunner: unknown
  }
  host.shouldUseNativeTools = () => true
  host.deliberationRunner = {
    async *executeWithToolsStream(_messages: unknown, tools: ReturnType<typeof buildChatToolDefinitions>) {
      advertised = tools.map(tool => tool.function.name)
      yield { type: 'text_delta', text: 'This request has read-only scope.' }
      yield { type: 'done', finishReason: 'stop' }
    },
    getLastInvocationMetadata: () => null,
  }
  for await (const _event of engine.submitMessageStream('Fix the parser.')) { /* exercise real request preparation */ }
  assert.ok(advertised.includes('read_file'))
  for (const denied of ['write_file', 'str_replace', 'apply_patch', 'run_command', 'sub_agent', 'web_fetch', 'mcp_request', 'lsp', 'finish']) {
    assert.ok(!advertised.includes(denied), denied)
  }
})

test('native and text tool projections withhold LSP without governed process admission', () => {
  const tools = buildChatToolDefinitions()
  for (const hostFallbackAllowed of [false, true]) {
    const policy = { operation: 'MUTATING' as const, hostFallbackAllowed, env: {} }
    const names = availableChatToolNames(tools.map(tool => tool.function.name), policy)
    assert.deepEqual(availableChatTools(tools, policy).map(tool => tool.function.name), names)
    assert.equal(names.includes('lsp'), false)
    assert.ok(!availableChatToolNames(names, { ...policy, operation: 'READ_ONLY' }).includes('lsp'))
  }
})

test('read-only verifier schemas and legacy manual expose only exact foreground commands', () => {
  const tools = availableChatTools(buildChatToolDefinitions(), {
    operation: 'READ_ONLY', requiredVerifiers: ['npm test', 'npm run typecheck'], env: {},
  })
  for (const tool of tools.filter(tool => ['run_command', 'test_run'].includes(tool.function.name))) {
    const schema = tool.function.parameters as { properties: Record<string, { enum?: string[] }> }
    assert.deepEqual(schema.properties['command']?.enum, ['npm test', 'npm run typecheck'])
    assert.ok(!('background' in schema.properties))
    assert.ok(!('detached' in schema.properties))
  }
  const prompt = buildChatSystemPrompt({ projectRoot: '.', availableToolDefinitions: tools })
  assert.match(prompt, /command="npm test"\|"npm run typecheck"/)
  assert.doesNotMatch(prompt, /background\?|detached\?/)
})

test('no-change completion requires real inspection and never certifies a patch', () => {
  const read: GateToolLogEntry = { tool: 'read_file', target: 'fixture.ts', detail: '1 line: export const answer = 42' }
  const gate = (log: GateToolLogEntry[], task = 'Fix the fixture.', extra = {}) => evaluateCompletionGateForEngine({
    turnType: 'completion', taskIntent: 'execute', task, taskClass: 'quick_fix',
    toolCallLog: log, lastVerifierReceipt: null, executedVerifierLedger: [], ...extra,
  })
  assert.equal(gate([]), 'reject')
  assert.equal(gate([{ ...read, error: 'ENOENT' }]), 'reject')
  assert.equal(gate([{ ...read, exit_code: 1 }]), 'reject')
  assert.equal(gate([{ tool: 'sub_agent', target: 'child', detail: 'Already fixed, tests passed' }]), 'reject')
  assert.equal(gate([read]), 'allow')
  // Background start/await logs can report exit 0 before their effects are
  // known. Neither a process acknowledgement nor its exit status proves no diff.
  for (const processResult of [
    { tool: 'run_command', target: 'node worker.mjs', detail: 'background started bg-1', exit_code: 0 },
    { tool: 'await_command', target: 'bg-1', detail: 'completed', exit_code: 0 },
    { tool: 'test_run', target: 'npm test', detail: 'passed', exit_code: 0 },
  ]) {
    assert.equal(gate([read, processResult]), 'reject', processResult.tool)
    assert.equal(gate([read, { ...processResult, effect_status: 'confirmed_no_change' }]), 'allow')
  }
  assert.equal(gate([read], 'Fix the fixture and run npm test before completing.'), 'reject')
  assert.equal(gate([read], 'Fix the fixture.', { requiredVerifierCommands: ['npm test'] }), 'reject')
  assert.equal(gate([read], 'Fix the fixture.', { verifierEvidenceErrors: ['simulated'] }), 'reject')
  for (const tool of ['write_file', 'str_replace', 'apply_patch']) {
    for (const error of ['blocked', 'failed']) {
      assert.equal(gate([read, { tool, target: 'fixture.ts', error }]), 'reject')
    }
  }
  assert.equal(gate([read, { tool: 'sub_agent', target: 'child', effect_status: 'indeterminate' }]), 'reject')
  assert.equal(gate([read, { tool: 'sub_agent', target: 'child', error: 'error', exit_code: 1 }]), 'reject')
  assert.equal(hasInspectedNoChangeEvidence([read, {
    tool: 'write_file', target: 'fixture.ts', detail: 'changed',
    effect_status: 'confirmed_change', mutation_paths: ['fixture.ts'],
  }]), false)
  const forged = createExecutorKernel('chat').completion.decide({
    mode: 'chat', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: false,
    verificationPolicy: 'none', toolCallLog: [read], proof: { compliant: true, errors: [] },
  })
  assert.equal(forged.allowed, false)
  assert.equal(forged.finalOutcome, 'UNVERIFIED_PATCH')
})
