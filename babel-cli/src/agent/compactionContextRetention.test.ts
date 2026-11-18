/**
 * TF-22 / Q11 — compaction must preserve the user's original task constraints.
 *
 * The heuristic compaction path drops old ChatMessage rows and replaces them
 * with a text summary. A 120-character excerpt of a user turn silently erased
 * everything the user wrote after column 120, so a long multi-constraint task
 * lost its later constraints on the first compaction. These tests exercise the
 * real heuristic compaction state machine across two compactions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactHeuristicConversation,
  summarizeDroppedTurns,
  type CompactConversationState,
} from './chatEngineSupport.js';
import type { ChatMessage } from './chatToolDefinitions.js';
import { commitCompaction } from './compactionCommit.js';
import {
  createThreadEventLog,
  rebuildProviderMessagesFromEvents,
  recordAssistantMessage,
  recordUserMessage,
  startTurn,
} from './threadEventLog.js';
import { createSessionEventLog } from './sessionEvents.js';

const INITIAL_TASK = [
  'Refactor the release report pipeline without breaking existing consumers.',
  'Constraints:',
  '(1) Never modify src/legacy/** or the generated schema snapshots.',
  '(2) Preserve the public JSON schema `babel.report.v2` exactly.',
  '(3) Keep Windows backslash path handling and LF output.',
  '(4) Do not add new dependencies or network calls.',
  '(5) Report the exact verifier command and its exit code.',
].join(' ');

const LATER_CONSTRAINT =
  'Additional constraint from the user: keep the smoke fixture under 2 seconds and never skip the negative control.';

function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra } as ChatMessage;
}

function heuristicState(conversation: ChatMessage[]): CompactConversationState {
  return {
    conversation,
    toolCallLog: [],
    lastVerifierReceipt: null,
    todosSize: 0,
    lastPhase: null,
    apiTokenCount: 0,
    maxConversationMessages: 8,
    maxEstimatedTokens: 1,
    compactionConsecutiveFailures: 0,
    maxCompactionFailures: 3,
    summarizeDroppedTurns,
  };
}

test('a dropped user turn keeps constraints beyond the first 120 characters', () => {
  const summary = summarizeDroppedTurns([
    message('user', INITIAL_TASK),
    message('tool', 'src/legacy/report.ts: read 1200 bytes'),
  ]);

  assert.match(summary, /\(1\) Never modify src\/legacy/);
  assert.match(summary, /\(2\) Preserve the public JSON schema/);
  assert.match(summary, /\(3\) Keep Windows backslash path handling/);
  assert.match(summary, /\(4\) Do not add new dependencies/);
  assert.match(summary, /\(5\) Report the exact verifier command/);
});

test('every dropped user turn survives even when more than eight facts exist', () => {
  const dropped: ChatMessage[] = [];
  for (let i = 0; i < 12; i++) {
    dropped.push(message('tool', `tool observation number ${i} with enough detail to be retained`));
    dropped.push(message('user', `user constraint ${i}: keep behavior ${i} intact`));
  }

  const summary = summarizeDroppedTurns(dropped);
  for (let i = 0; i < 12; i++) {
    assert.match(summary, new RegExp(`user constraint ${i}: keep behavior ${i} intact`));
  }
});

test('initial task constraints survive two heuristic compactions', () => {
  const conversation: ChatMessage[] = [message('system', 'system policy')];
  conversation.push(message('user', INITIAL_TASK));
  for (let i = 0; i < 10; i++) {
    conversation.push(message('assistant', `assistant turn ${i}`));
    conversation.push(message('tool', `tool output ${i}\nsecond line`));
    conversation.push(message('user', `follow-up ${i}: continue with step ${i}`));
  }

  const first = heuristicState(conversation);
  compactHeuristicConversation(first);
  const afterFirst = JSON.stringify(first.conversation);
  assert.match(afterFirst, /\(4\) Do not add new dependencies/, 'first compaction lost a later constraint');
  assert.match(afterFirst, /\(5\) Report the exact verifier command/, 'first compaction lost the final constraint');
  assert.match(afterFirst, /follow-up 9/, 'first compaction lost the most recent user turn');

  // A second, later batch of turns plus another compaction must not erase the
  // constraints that are now only present in the compacted summary.
  for (let i = 0; i < 10; i++) {
    first.conversation.push(message('assistant', `second batch assistant ${i}`));
    first.conversation.push(message('tool', `second batch tool ${i}\nsecond line`));
    first.conversation.push(message('user', i === 0 ? LATER_CONSTRAINT : `second batch user ${i}`));
  }
  compactHeuristicConversation(first);

  const afterSecond = JSON.stringify(first.conversation);
  assert.match(afterSecond, /\(1\) Never modify src\/legacy/, 'second compaction lost constraint 1');
  assert.match(afterSecond, /\(4\) Do not add new dependencies/, 'second compaction lost constraint 4');
  assert.match(afterSecond, /keep the smoke fixture under 2 seconds/, 'second compaction lost a later user constraint');
});

test('oversized user text is retained with an explicit truncation marker', () => {
  const oversized = `START_MARKER ${'x'.repeat(20_000)} END_MARKER`;
  const summary = summarizeDroppedTurns([message('user', oversized)]);

  assert.match(summary, /START_MARKER/);
  assert.match(summary, /END_MARKER/);
  assert.match(summary, /truncated/i);
});

test('a retained window without a user turn still carries the dropped constraints', () => {
  const conversation: ChatMessage[] = [
    message('system', 'system policy'),
    message('user', INITIAL_TASK),
    message('assistant', 'Acknowledged.'),
    message('tool', `tool line a\n${'detail '.repeat(60)}`),
    message('user', 'Additional detail for the same task.'),
    message('tool', `tool line b\n${'detail '.repeat(60)}`),
    message('assistant', 'Next step.'),
    message('tool', `tool line c\n${'detail '.repeat(60)}`),
    message('assistant', 'Checking.'),
    message('tool', `tool line d\n${'detail '.repeat(60)}`),
  ];
  const state = heuristicState(conversation);
  state.maxConversationMessages = 4;
  compactHeuristicConversation(state);

  assert.ok(state.conversation.some((entry) => entry.role === 'user'));
  assert.match(JSON.stringify(state.conversation), /\(4\) Do not add new dependencies/);
});

test('cold-resume projection keeps the full original task after a heuristic commit', async () => {
  const threadLog = createThreadEventLog('thread-compaction-retention');
  const sessionLog = createSessionEventLog('thread-compaction-retention');
  startTurn(threadLog, {
    task: INITIAL_TASK,
    model: 'deepseek-chat',
    provider: 'deepseek',
    projectRoot: '/tmp/project',
    policyPreset: 'chat',
  });
  const turnId = threadLog.events.find((event) => event.kind === 'turn_started')!.turn_id;
  recordUserMessage(threadLog, turnId, INITIAL_TASK);
  recordAssistantMessage(threadLog, turnId, 'Working through the constraints.');

  const prior: ChatMessage[] = [
    message('system', 'system policy'),
    message('user', INITIAL_TASK),
    message('assistant', 'Working through the constraints.'),
    message('user', LATER_CONSTRAINT),
    message('assistant', 'Acknowledged.'),
  ];
  const summary = summarizeDroppedTurns(prior.slice(1, 3));
  const strategyMessages: ChatMessage[] = [
    message('system', 'system policy'),
    message('user', `${summary}\n\n${LATER_CONSTRAINT}`),
    message('assistant', 'Acknowledged.'),
  ];

  const commit = await commitCompaction({
    strategyMessages,
    priorConversation: prior,
    strategy: 'heuristic',
    tokensBefore: 1_000,
    tokensAfter: 200,
    operational: { task: INITIAL_TASK },
    threadLog,
    sessionLog,
    turnId,
    modelId: 'deepseek-chat',
  });

  assert.equal(commit.status, 'committed', 'heuristic commit must persist');
  const capsule = commit.conversation.find((entry) => entry.name === 'compaction_capsule');
  assert.ok(capsule, 'a durable capsule must exist');
  assert.match(capsule!.content, /Never modify src\/legacy/);
  assert.match(capsule!.content, /Report the exact verifier command/);

  const rebuilt = rebuildProviderMessagesFromEvents(threadLog);
  assert.ok(
    rebuilt.some((entry) => entry.content?.includes(INITIAL_TASK)),
    'cold-resume projection must retain the complete original task',
  );
  assert.ok(
    rebuilt.some((entry) => entry.content?.includes('keep the smoke fixture under 2 seconds')
      || entry.content?.includes('Additional constraint from the user')),
    'cold-resume projection must retain the later user constraint summary',
  );
});
