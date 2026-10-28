import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'
import type { RequiredVerifierRecord } from '../executor/contracts.js'
import { parseCommandArgv } from '../utils/commandArgv.js'
import {
  evaluateCompletionGateForEngine,
  evaluateExecuteCompletionHonesty,
  hasInspectedNoChangeEvidence,
  type VerifierReceipt,
} from './completionGatePolicy.js'

const executionContext = {
  workspaceRoot: '/workspace/project', taskId: 'task', contractHash: 'contract',
  workingDirectory: '/workspace/project', environmentFingerprint: 'environment', targetSelectors: [],
}
const owner = { workspaceRoot: executionContext.workspaceRoot, taskId: 'task', contractHash: 'contract', sessionId: 'session' }
const required = (command: string): RequiredVerifierRecord => ({ command, executionContext: { ...executionContext, targetSelectors: analyzeVerifierIdentity(command)?.targetSelectors ?? [] }, requiredScope: command.includes('Value') ? 'targeted' : 'full_suite', greenRequired: true })
function receipt(command: string, seq: number, extra: Record<string, unknown> = {}): VerifierReceipt {
  return {
    command, exit_code: 0, authority: true, authoritySource: 'built_in_runner', verifierId: 'node-test',
    receiptId: `receipt-${seq}`, capturedAt: 100, argv: parseCommandArgv(command), summary: '# tests 3\n# skipped 0',
    tests_total: 3, tests_skipped: 0, stale: false, scope: command.includes('Value') ? 'targeted' : 'full_suite',
    boundRevision: { gitCommitHash: null, compositeTreeHash: 'revision', fileHashes: {}, capturedAt: 100 },
    executionContext: { ...executionContext, targetSelectors: analyzeVerifierIdentity(command)?.targetSelectors ?? [] }, order: { sessionId: 'session', seq }, ...extra,
  }
}
function honest(commands: string[], receipts: VerifierReceipt[], extra: Partial<Parameters<typeof evaluateExecuteCompletionHonesty>[0]> = {}): ReturnType<typeof evaluateExecuteCompletionHonesty> {
  return evaluateExecuteCompletionHonesty({
    hasWrite: true, policy: 'strict', requiredVerifierCommands: commands, executedVerifierLedger: receipts, toolCallLog: [],
    requiredVerifiers: commands.map(required), verifierOwner: owner, currentWorkspaceRevisionHash: 'revision', ...extra,
  })
}
function gate(commands: string[], receipts: VerifierReceipt[], extra: Partial<Parameters<typeof evaluateCompletionGateForEngine>[0]> = {}): 'allow' | 'reject' {
  return evaluateCompletionGateForEngine({
    turnType: 'completion', taskIntent: 'execute', task: 'Fix the implementation and run tests before completing',
    taskClass: 'general_swe', toolCallLog: [{ tool: 'write_file', target: 'src/value.ts', effect_status: 'confirmed_change' }],
    lastVerifierReceipt: null, requiredVerifierCommands: commands, executedVerifierLedger: receipts,
    currentWorkspaceRevisionHash: 'revision', requiredVerifiers: commands.map(required), verifierOwner: owner, ...extra,
  })
}

test('coverage green survives a later plain green in a different execution slot', () => {
  assert.equal(honest(['npm test -- --coverage'], [receipt('npm test -- --coverage', 1), receipt('npm test', 2)]).allow, true)
})

test('current covering green supersedes stale red including stale last display receipt', () => {
  const red = receipt('node --test', 1, { stale: true, exit_code: 1 })
  const green = receipt('node --test', 2)
  assert.equal(gate(['node --test'], [red, green], { lastVerifierReceipt: red }), 'allow')
  assert.equal(gate(['node --test'], [red]), 'reject')
})

test('durable order wins over timestamps and array replacement position', () => {
  const green = receipt('node --test', 3, { capturedAt: 1 })
  const red = receipt('node --test', 2, { exit_code: 1, capturedAt: 999 })
  assert.equal(honest(['node --test'], [green, red]).allow, true)
  assert.equal(honest(['node --test'], [green, { ...red, order: { sessionId: 'session', seq: 4 } }]).allow, false)
})

test('broad red remains unresolved after narrow or disjoint green', () => {
  const narrow = 'node --test Value.test.js'
  assert.equal(honest([narrow], [receipt('node --test', 1, { exit_code: 1 }), receipt(narrow, 2)]).allow, false)
  assert.equal(honest([narrow], [receipt('node --test', 1, { exit_code: 1 }), receipt(narrow, 2), receipt('node --test', 3)]).allow, true)
  assert.equal(honest([narrow], [receipt(narrow, 1, { exit_code: 1 }), receipt('node --test Other.test.js', 2)]).allow, false)
})

test('host context cannot be supplied by a receipt from another root, owner, cwd or environment', () => {
  for (const field of ['workspaceRoot', 'taskId', 'contractHash', 'workingDirectory', 'environmentFingerprint']) {
    assert.equal(gate(['node --test'], [receipt('node --test', 1, { executionContext: { ...executionContext, [field]: 'wrong' } })]), 'reject', field)
  }
  assert.equal(gate(['node --test'], [receipt('node --test', 1, { order: undefined })]), 'reject')
  assert.equal(gate(['node --test'], [receipt('node --test', 1, { executionContext: undefined })]), 'reject')
})

test('targeted host requirement has one result under both ordinary phrasings', () => {
  const command = 'node --test Value.test.js'
  for (const task of ['Fix and run targeted tests', 'Fix and run tests before completing']) {
    assert.equal(gate([command], [receipt(command, 1)], { task }), 'allow', task)
  }
  assert.equal(gate(['node --test'], [receipt(command, 1)]), 'reject')
})

test('integrity findings survive successful current proof selection', () => {
  const old = receipt('node --test', 1, { stale: true, exit_code: 1, summary: 'VERIFIER_DEF_TAMPERED' })
  assert.equal(gate(['node --test'], [old, receipt('node --test', 2)]), 'reject')
  assert.equal(gate(['node --test'], [receipt('node --test', 2)], { adversarial: { tests_deleted: true } }), 'reject')
})

test('only explicit predispatch no-effect denials allow inspected no-change', () => {
  const inspection = { tool: 'read_file', target: 'src/value.ts', detail: 'observed source' }
  const denial = { tool: 'run_command', target: 'node --test', error: 'blocked' }
  assert.equal(hasInspectedNoChangeEvidence([inspection, { ...denial, preDispatchNoEffect: true }]), true)
  assert.equal(hasInspectedNoChangeEvidence([inspection, denial]), false)
  assert.equal(hasInspectedNoChangeEvidence([{ ...denial, preDispatchNoEffect: true }]), false)
})


test('native Alpha failure cannot be certified with a passing alpha execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-selector-native-'))
  try {
    writeFileSync(join(root, 'selector.test.cjs'), `const test = require('node:test');
const assert = require('node:assert/strict');
test('Alpha', () => assert.fail('intentional regression'));
test('alpha', () => assert.equal(1, 1));
`)
    const childEnv = { ...process.env }; delete childEnv['NODE_TEST_CONTEXT']
    const run = (selector: string) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${selector}`, 'selector.test.cjs'], { cwd: root, env: childEnv, encoding: 'utf8' })
    const red = run('Alpha')
    const green = run('alpha')
    assert.equal(red.status, 1)
    assert.equal(green.status, 0)
    assert.match(green.stdout, /# pass 1/)
    const requiredCommand = 'node --test --test-name-pattern=Alpha selector.test.cjs'
    const actualCommand = 'node --test --test-name-pattern=alpha selector.test.cjs'
    assert.equal(gate([requiredCommand], [receipt(actualCommand, 1, { scope: 'targeted', summary: green.stdout })]), 'reject')
    assert.equal(gate([actualCommand], [receipt(actualCommand, 1, { scope: 'targeted', summary: green.stdout })], {
      requiredVerifiers: [{ ...required(actualCommand), requiredScope: 'targeted' }],
    }), 'allow')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('structured verifier argv is the same argv the executor parses', async () => {
  const { parseStructuredVerifierCommand } = await import('./completionGatePolicy.js')
  assert.deepEqual(parseStructuredVerifierCommand('node --test --test-name-pattern="A  B"')?.args,
    ['--test', '--test-name-pattern=A  B'])
})

test('caller false flags cannot erase independently observed verifier tampering', () => {
  const old = receipt('node --test', 1, { stale: true, exit_code: 1, summary: 'VERIFIER_DEF_TAMPERED' })
  assert.equal(gate(['node --test'], [old, receipt('node --test', 2)], { adversarial: { verifier_def_tampered: false } }), 'reject')
})

test('an unordered current failure cannot disappear beside valid green proof', () => {
  const unknown = receipt('node --test', 1, { exit_code: 1 })
  delete unknown.order
  assert.equal(gate(['node --test'], [unknown, receipt('node --test', 2)]), 'reject')
})

test('conflicting command/argv or selector projection cannot certify', () => {
  assert.equal(gate(['node --test'], [receipt('node --test', 1, { argv: ['node', '--help'] })]), 'reject')
  assert.equal(gate(['node --test'], [receipt('node --test', 1, { executionContext: { ...executionContext, targetSelectors: ['other'] } })]), 'reject')
})

test('host targeted records take precedence over discovered defaults without duplicating legacy commands', () => {
  const command = 'node --test Value.test.js'
  assert.equal(gate([], [receipt(command, 1)], {
    requiredVerifierCommands: [], requiredVerifiers: [required(command)], projectTestCommands: ['node --test'],
  }), 'allow')
})

test('known other sessions are history and malformed expected selectors fail closed', () => {
  const previous = receipt('node --test', 1, { order: { sessionId: 'previous-session', seq: 100 } })
  assert.equal(gate(['node --test'], [previous, receipt('node --test', 2)]), 'allow')
  const command = 'node --test Value.test.js'
  assert.equal(gate([command], [receipt(command, 1)], {
    requiredVerifiers: [{ ...required(command), executionContext: { ...executionContext, targetSelectors: ['WRONG'] } }],
  }), 'reject')
  assert.equal(gate(['node --test'], [receipt('node --test', 1, { executionContext: null })]), 'reject')
})

test('malformed session IDs are unknown current evidence rather than known history', () => {
  for (const order of [{ seq: 2 }, { sessionId: '', seq: 2 }, { sessionId: null, seq: 2 }]) {
    assert.equal(gate(['node --test'], [receipt('node --test', 1), receipt('node --test', 2, { exit_code: 1, order })]), 'reject')
  }
})

test('independent live hashes preserve receipts with different bound scopes on the same candidate', () => {
  const tests = receipt('npm test', 1, { boundRevision: { compositeTreeHash: 'repository-hash', scope: { kind: 'repository' } } })
  const types = receipt('npm run typecheck', 2, { boundRevision: { compositeTreeHash: 'files-hash', scope: { kind: 'files', paths: ['src/value.ts'] } } })
  const commands = ['npm test', 'npm run typecheck']
  const currency = { currentWorkspaceRevisionHash: 'files-hash', currentReceiptRevisionHashes: { 'receipt-1': 'repository-hash', 'receipt-2': 'files-hash' } }
  assert.equal(gate(commands, [tests, types], currency), 'allow')
  assert.equal(gate(commands, [tests, types], { ...currency, currentReceiptRevisionHashes: { 'receipt-1': 'changed-repository-hash', 'receipt-2': 'files-hash' } }), 'reject')
  assert.equal(gate(commands, [tests, types], { ...currency, currentReceiptRevisionHashes: { 'receipt-2': 'files-hash' } }), 'reject')
})

test('an ordinary default task respects an explicit targeted host obligation while stronger profiles remain full-suite', () => {
  const command='node --test Value.test.js'
  const green=receipt(command,1)
  assert.equal(gate([command],[green],{taskClass:'default'}),'allow')
  assert.equal(gate([command],[green],{taskClass:'governance'}),'reject')
  assert.equal(gate([command],[green],{taskClass:'default',requiredVerifiers:[{...required(command),requiredScope:'full_suite'}]}),'reject')
})

test('required delivery without a frozen verifier plan uses host-bound attempts but cannot mint certification',()=>{
 const command='node --test Value.test.js';const green=receipt(command,1)
 const input={hasWrite:true,policy:'required' as const,toolCallLog:[],requiredVerifierCommands:[],requiredVerifiers:[],verifierOwner:owner,
  currentWorkspaceRevisionHash:'revision',executedVerifierLedger:[green],unplannedAttemptEnvironmentFingerprint:'environment'}
 assert.equal(evaluateExecuteCompletionHonesty(input).allow,true)
 assert.equal(evaluateExecuteCompletionHonesty({...input,executedVerifierLedger:[{...green,exit_code:1}]}).allow,true,'real red permits truthful partial delivery')
 assert.equal(evaluateExecuteCompletionHonesty({...input,policy:'strict'}).allow,false,'no frozen obligation cannot certify')
 const withoutOrder={...green};delete withoutOrder.order
 const invalidAttempts=[withoutOrder,{...green,executionContext:{...executionContext,environmentFingerprint:'wrong'}},
  {...green,executionContext:{...executionContext,workingDirectory:'/outside'}},{...green,stale:true}]
 for(const bad of invalidAttempts)
  assert.equal(evaluateExecuteCompletionHonesty({...input,executedVerifierLedger:[bad]}).allow,false)
})
