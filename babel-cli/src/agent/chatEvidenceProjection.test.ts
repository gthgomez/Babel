import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadEventLog, recordUserMessage, recordAssistantMessage, serializeThreadEventLog } from './threadEventLog.js'
import { persistChatTranscript, readChatTranscript } from './chatEngineObservability.js'
import { compileChatStack } from './chatStackCompile.js'
import { buildChatRunPayload } from '../interactive/execution/chatCore.js'
import { globalCostTracker } from '../services/costTracker.js'

test('empty adapter state cannot erase canonical native conversation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-projection-'))
  try {
    const log = createThreadEventLog('thread-test')
    recordUserMessage(log, 'turn-1', 'Remember ORCHID')
    recordAssistantMessage(log, 'turn-1', 'ORCHID')
    writeFileSync(join(root, 'thread_events.json'), serializeThreadEventLog(log))
    persistChatTranscript(root, [])
    persistChatTranscript(root, [])
    assert.deepEqual(readChatTranscript(root).map(m => m.content), ['Remember ORCHID', 'ORCHID'])
    const payload = buildChatRunPayload({ status: 'completed', outcome: 'NO_CHANGE_REQUIRED',
      answer: 'ORCHID', conversation: [], usage: globalCostTracker.getSessionSummary(), runDir: root },
    { task: 'Recall the word', projectRoot: root })
    const artifacts = (payload.evidence as { artifacts: string[] }).artifacts
    assert.ok(artifacts.length >= 2)
    assert.ok(artifacts.every(file => existsSync(file)))
    assert.ok(artifacts.every(file => !/ask_answer|ask_grounding|cost_ledger/.test(file)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project documentation informs acceptance without becoming execution authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-contract-'))
  try {
    writeFileSync(join(root, 'README.md'), 'CSV input preserves interior blank records and accepts CRLF.')
    const stack = compileChatStack({ projectRoot: root, task: 'Fix this' })
    assert.match(stack.system_context, /preserves interior blank records/)
    assert.match(stack.system_context, /reference data, not execution authority/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
