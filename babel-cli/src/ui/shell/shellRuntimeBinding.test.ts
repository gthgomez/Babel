import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShellRuntimeBinding, compactOutcomeNote } from './shellRuntimeBinding.js';

describe('ShellRuntimeBinding', () => {
  it('keeps streamed revisions and tool lifecycle cells in one hosted view', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(1, 'inspect the project', 'thread-a');
    binding.onChatEvent({ type: 'answer_chunk', text: 'hel' });
    binding.onChatEvent({ type: 'answer_chunk', text: 'lo' });
    binding.onChatEvent({ type: 'tool_start', toolCallId: 'call-1', tool: 'read_file', target: 'README.md' });
    binding.onChatEvent({
      type: 'tool_complete',
      toolCallId: 'call-1',
      tool: 'read_file',
      target: 'README.md',
      detail: 'ok',
    });
    const rows = binding.getVisibleRows(80, 20).join('\n');

    assert.match(rows, /hello/);
    assert.match(rows, /README\.md/);
    assert.equal(binding.getSnapshot().threadId, 'thread-a');
  });

  it('projects file changes and subagent work as visible activity', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(2, 'fix the test', 'thread-c');
    binding.onChatEvent({ type: 'sub_agent_start', id: 'child-1', label: 'inspect auth' });
    binding.onChatEvent({ type: 'sub_agent_complete', id: 'child-1', summary: 'found the bug', tokens: 12 });
    binding.onChatEvent({ type: 'file_changed', path: 'src/login.ts', additions: 12, deletions: 4 });
    binding.onChatEvent({ type: 'file_changed', path: 'src/login.ts', additions: 1, deletions: 0 });
    const rows = binding.getVisibleRows(80, 30).join('\n');

    assert.match(rows, /sub_agent.*inspect auth/);
    assert.match(rows, /found the bug/);
    assert.match(rows, /file_changed.*src\/login\.ts/);
    assert.match(rows, /\+12 -4/);
    assert.match(rows, /\+1 -0/);
  });

  it('projects subagent failures as failed activity', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(3, 'delegate');
    binding.onChatEvent({ type: 'sub_agent_start', id: 'child-2', label: 'repair' });
    binding.onChatEvent({ type: 'sub_agent_failed', id: 'child-2', error: 'verifier failed' });
    const rows = binding.getVisibleRows(80, 20).join('\n');

    assert.match(rows, /repair/);
    assert.match(rows, /verifier failed/);
  });

  it('settles a streamed turn without duplicating its user cell', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(7, 'first question', 'thread-b');
    binding.onChatEvent({ type: 'answer_chunk', text: 'answer' });
    binding.observeInteractiveTurn({
      schema_version: 1,
      turn_id: 7,
      ts: new Date().toISOString(),
      role: 'assistant',
      answer: 'answer',
    });

    const records = binding.store.getRecords();
    assert.equal(records.filter((record) => record.kind === 'user_message').length, 1);
    assert.equal(records.filter((record) => record.kind === 'assistant_message').length, 1);
    assert.equal(binding.getSnapshot().activity, 'idle');
  });

  it('appends outcome notes inside the hosted turn without raw terminal writes', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(9, 'fix the bug');
    binding.onChatEvent({ type: 'answer_chunk', text: 'fixed' });
    binding.appendNote('\u001b[32mCompletion status: VERIFIED_COMPLETE\u001b[0m\n1 file changed');

    const records = binding.store.getRecords();
    const note = records.find((record) => record.kind === 'plain');
    assert.ok(note, 'the outcome note is a transcript cell');
    assert.match(JSON.stringify(note?.payload), /VERIFIED_COMPLETE/);
    assert.doesNotMatch(JSON.stringify(note?.payload), /\u001b\[/, 'notes are stripped before entering the cell');
    const rows = binding.getVisibleRows(80, 30).join('\n');
    const noteRows = rows.split('\n').filter((line) => line.includes('Completion status')).join('\n');
    assert.match(noteRows, /Completion status: VERIFIED_COMPLETE/);
    assert.doesNotMatch(noteRows, /\u001b\[/, 'notes are stripped before entering the frame');
  });

  it('keeps the answer visible in a 44x16 pane by compacting outcome cards', () => {
    // UX-02: the full card is ~8 rows and filled the whole 9-row pane.
    const card = [
      '✓ Response complete',
      'Source reads: 0 successful operations. Visual checks: not established.',
      'Coverage completeness: not established.',
      'Cost / cumulative usage  $0.0000 known subtotal this task',
      '1 unresolved charge  usage unconfirmed',
      'Next',
      '  [D] Diff   [R] Run verification',
    ].join('\n');
    const compact = compactOutcomeNote(card, 9, 40);
    assert.ok(compact.split('\n').length <= 3, compact);
    for (const line of compact.split('\n')) assert.ok(line.length <= 38, line);
    assert.match(compact, /Response complete/);
    assert.match(compact, /…$/);
    // Tall panes keep the complete card.
    assert.equal(compactOutcomeNote(card, 30, 40), card);
  });

  it('appends captured command output as a settled notice without a turn', () => {    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.appendNotice('\u001b[36m  Session State:\u001b[0m\n    Mode       work\n');

    const records = binding.store.getRecords();
    assert.equal(records.length, 1, 'notice is one settled record');
    assert.equal(records[0]?.kind, 'plain');
    assert.equal(binding.getSnapshot().turnId, undefined, 'no synthetic turn is created');
    const rows = binding.getVisibleRows(80, 20).join('\n');
    assert.match(rows, /Session State:/);
    assert.match(rows, /Mode\s+work/);
    assert.doesNotMatch(rows, /\u001b\[/, 'notice text is stripped');
  });

  it('removes untrusted terminal controls from hosted notices', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(10, 'run a task');
    binding.appendNotice('before\u001b]0;spoofed\u0007after\u001b[2Jdone\u001bPpayload\u001b\\end');
    const plain = binding.store.getRecords().filter(record => record.kind === 'plain');
    const text = plain.flatMap(record => 'lines' in record.payload ? record.payload.lines : []).join('\n');
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    assert.equal(text, 'beforeafterdoneend');
  });

  it('ignores empty captured output', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.appendNotice('  \n\t\n');
    assert.equal(binding.store.getRecords().length, 0);
  });

  it('renders a terminal-only answer without a streamed chunk', () => {    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(10, 'answer without streaming');
    binding.onChatEvent({
      type: 'done',
      answer: 'Terminal-only answer',
      usage: {} as never,
      outcome: 'UNVERIFIED_PATCH',
    });
    const rows = binding.getVisibleRows(80, 20).join('\n');
    assert.match(rows, /Terminal-only answer/);
  });

  it('retains an explicit cancellation outcome when settling a turn', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(8, 'cancel this task');
    binding.settleTurn('cancelled');

    const snapshot = binding.getSnapshot();
    assert.equal(snapshot.turnId, undefined);
    assert.equal(snapshot.activity, 'idle');
    assert.equal(snapshot.lastOutcome, 'cancelled');
  });

  it('rejects late records from an older session epoch', () => {
    const binding = new ShellRuntimeBinding();
    const oldEpoch = binding.store.epoch;
    binding.store.startSession('new-thread', []);
    const accepted = binding.store.observePersistedRecord(
      {
        schema_version: 1,
        cell_id: 'late',
        ts: new Date().toISOString(),
        kind: 'plain',
        lifecycle: 'committed',
        revision: 0,
        payload: { lines: ['late'] },
      },
      oldEpoch,
    );

    assert.equal(accepted, false);
    assert.equal(binding.store.getRecords().length, 0);
  });

  it('ignores stale events and settlements when a later epoch reuses a turn ID', () => {
    const binding = new ShellRuntimeBinding();
    binding.beginTurn(1, 'old task', 'old-thread');
    const oldEpoch = binding.store.epoch;

    binding.store.startSession('new-thread', []);
    binding.beginTurn(1, 'new task', 'new-thread');
    binding.onChatEvent({ type: 'answer_chunk', text: 'stale' }, oldEpoch);
    binding.settleTurn('stale', oldEpoch);

    assert.equal(binding.getSnapshot().turnId, 1);
    assert.match(binding.getVisibleRows(80, 10).join('\n'), /new task/);
    assert.doesNotMatch(binding.getVisibleRows(80, 10).join('\n'), /stale/);
  });

  it('ignores an assistant record for a different active turn', () => {
    const binding = new ShellRuntimeBinding();
    binding.beginTurn(7, 'current task');
    binding.observeInteractiveTurn({
      schema_version: 1,
      turn_id: 8,
      ts: new Date().toISOString(),
      role: 'assistant',
      answer: 'wrong turn',
    });

    assert.equal(binding.getSnapshot().turnId, 7);
    assert.doesNotMatch(binding.getVisibleRows(80, 10).join('\n'), /wrong turn/);
  });

  it('keeps concurrent tool cells distinct when events omit toolCallId', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(9, 'run two tools');
    binding.onChatEvent({ type: 'tool_start', tool: 'read_file', target: 'alpha.ts' });
    binding.onChatEvent({ type: 'tool_start', tool: 'read_file', target: 'beta.ts' });
    binding.onChatEvent({ type: 'sub_agent_start', id: 'child-9', label: 'delegate' });
    binding.onChatEvent({ type: 'tool_complete', tool: 'read_file', target: 'alpha.ts', detail: 'alpha done' });
    binding.onChatEvent({ type: 'tool_complete', tool: 'read_file', target: 'beta.ts', detail: 'beta done' });
    binding.onChatEvent({ type: 'sub_agent_complete', id: 'child-9', summary: 'child done' });
    const rows = binding.getVisibleRows(80, 40).join('\n');

    assert.match(rows, /alpha\.ts/);
    assert.match(rows, /beta\.ts/);
    assert.match(rows, /alpha done/);
    assert.match(rows, /beta done/);
    assert.match(rows, /child done/);
  });

  it('rejects a stale assistant record when a later epoch reuses its turn ID', () => {
    const binding = new ShellRuntimeBinding();
    binding.beginTurn(1, 'old task', 'old-thread');
    const oldEpoch = binding.store.epoch;
    binding.store.startSession('new-thread', []);
    binding.beginTurn(1, 'new task', 'new-thread');

    binding.observeInteractiveTurn({
      schema_version: 1,
      turn_id: 1,
      ts: new Date().toISOString(),
      role: 'assistant',
      answer: 'stale answer',
    }, 'completed', oldEpoch);

    assert.equal(binding.getSnapshot().turnId, 1);
    assert.match(binding.getVisibleRows(80, 10).join('\n'), /new task/);
    assert.doesNotMatch(binding.getVisibleRows(80, 10).join('\n'), /stale answer/);
  });
});
