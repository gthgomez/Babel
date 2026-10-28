import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedVerifierContextKey, matchesFailedVerifierReplay, validFailedVerifierExecution } from './failedVerifierExecution.js'
import { parseCommandArgv } from '../../utils/commandArgv.js'

const owner = { workspaceRoot: '/repo', taskId: 'task', contractHash: 'contract', sessionId: 'session' }
const command = 'node --test "test/Alpha  beta.test.js"'
const descriptor = { schemaVersion: 1 as const, command, argv: parseCommandArgv(command), owner, cwd: '/repo', environmentFingerprint: 'env',
  candidate: { schemaVersion: 1 as const, taskId: 'task', contractHash: 'contract', repositoryIdentity: '/repo', workspaceRevision: 'revision' },
  toolCallId: 'physical-call', order: { sessionId: 'session', seq: 4 }, processStarted: true as const, exitCode: 1, termination: 'exited' as const,
  executionFingerprint: failedVerifierContextKey(command, owner, '/repo', 'env') }

test('failed native rerun matches exact argv and accepted execution context, not tool name or receipt presence', () => {
  assert.equal(validFailedVerifierExecution(descriptor), true)
  const input = { command, owner, cwd: '/repo', environmentFingerprint: 'env' }
  assert.equal(matchesFailedVerifierReplay(descriptor, input), true)
  for (const altered of [{ command: 'node -e "1"' }, { command: command.replace('  ', ' ') }, { cwd: '/other' },
    { environmentFingerprint: 'other' }, { owner: { ...owner, taskId: 'other' } }, { owner: { ...owner, workspaceRoot: '/other' } }, { owner: { ...owner, sessionId: 'other' } }]) {
    assert.equal(matchesFailedVerifierReplay(descriptor, { ...input, ...altered }), false)
  }
  for (const altered of [{ processStarted: false }, { exitCode: 0 }, { termination: 'cancelled' }, { argv: ['node', '--version'] }, { order: { sessionId: 'other', seq: 4 } }]) {
    assert.equal(validFailedVerifierExecution({ ...descriptor, ...altered }), false)
  }
})


test('malformed persisted or proposed commands are rejected without throwing', () => {
  for (const command of ['', 'node --test "']) {
    assert.equal(validFailedVerifierExecution({ ...descriptor, command }), false)
    assert.equal(matchesFailedVerifierReplay(descriptor, { command, owner, cwd: '/repo', environmentFingerprint: 'env' }), false)
  }
})

test('an unbound broad failure cannot be erased by narrow green, wrong context or old green', async () => {
  const { unresolvedFailedVerifierHistory } = await import('./failedVerifierExecution.js')
  const failed = { ...descriptor, command:'node --test', argv:['node','--test'], executionFingerprint:failedVerifierContextKey('node --test',owner,'/repo','env') }
  const green: import('../../executor/contracts.js').ExecutorVerifierReceipt = { receiptId:'green',authority:true,authoritySource:'built_in_runner',capturedAt:100,tests_total:1,tests_skipped:0,tests_failed:0,boundRevision:{gitCommitHash:null,compositeTreeHash:'revision',fileHashes:{},capturedAt:100}, command:'node --test', exitCode:0, stale:false, order:{sessionId:'session',seq:5}, executionContext:{workspaceRoot:'/repo',taskId:'task',contractHash:'contract',workingDirectory:'/repo',environmentFingerprint:'env',targetSelectors:[]} }
  assert.deepEqual(unresolvedFailedVerifierHistory([failed],[green]),[])
  for (const altered of [{command:'node --test other.test.js'},{exitCode:1},{tests_total:0},{tests_total:1,tests_skipped:1},{tests_failed:1},{stale:true},{order:{sessionId:'session',seq:3}},
    {executionContext:{...green.executionContext!,environmentFingerprint:'other'}},{executionContext:{...green.executionContext!,taskId:'other'}}]) {
    assert.equal(unresolvedFailedVerifierHistory([failed],[{...green,...altered}]).length,1)
  }
})

test('cold restore requires host start/settlement/terminal facts and the accepted owner', async () => {
  const { createSessionEventLog, recordToolProposed, recordToolStarted, recordVerifierAttempt, recordToolTerminal, serializeSessionEventLog, parseSessionEventLog } = await import('../sessionEvents.js')
  const { restoreFailedVerifierHistory, attestedFailedVerifierExecution } = await import('./failedVerifierExecution.js')
  const log=createSessionEventLog('session')
  recordToolProposed(log,{turn_id:'turn',tool_call_id:'physical-call',tool_name:'test_run'})
  recordToolStarted(log,{turn_id:'turn',tool_call_id:'physical-call',tool_name:'test_run'})
  const event=recordVerifierAttempt(log,{turn_id:'turn',tool_call_id:'physical-call',command_preview:command,authoritative:false,exit_code:1})
  const actual={...descriptor,order:{sessionId:event.session_id,seq:event.seq}}
  if(event.kind==='verifier_attempt')event.failed_execution=actual
  assert.equal(attestedFailedVerifierExecution(log,actual),false,'not terminal yet')
  recordToolTerminal(log,{turn_id:'turn',tool_call_id:'physical-call',tool_name:'test_run',exit_code:1,failed:true})
  const restored=parseSessionEventLog(serializeSessionEventLog(log),'session')
  assert.deepEqual(restoreFailedVerifierHistory(restored,owner).history,[actual])
  assert.deepEqual(restoreFailedVerifierHistory(restored,{...owner,taskId:'other'}).history,[])
  assert.equal(attestedFailedVerifierExecution(restored,{...actual,toolCallId:'fabricated'}),false)
  const terminal=restored.events.at(-1)!
  Object.assign(terminal,{kind:'tool_cancelled'})
  assert.equal(attestedFailedVerifierExecution(restored,actual),false)
})
