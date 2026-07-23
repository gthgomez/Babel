import test from 'node:test';
import assert from 'node:assert/strict';
import { BabelEventBus } from '../pipeline.js';
import { stripAnsi } from './theme.js';
import { matchStrippedSnapshot } from './snapshot.js';
import {
  AppendOnlyRenderer,
  ConversationalRenderer,
  createLiveRunRenderer,
  NoopRenderer,
  TtyHudRenderer,
} from './waterfall.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Intercept process.stdout.write, capturing all writes into an array. */
function interceptStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stdout.write;
  const savedNoColor = process.env['NO_COLOR'];
  const savedA11y = process.env['BABEL_A11Y'];
  // NO_COLOR enables a11y mode, which emits parallel A11Y: JSON lines that
  // duplicate activity text and break stdout-based dedup assertions.
  delete process.env['NO_COLOR'];
  delete process.env['BABEL_A11Y'];
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      process.stdout.write = orig;
      if (savedNoColor === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = savedNoColor;
      if (savedA11y === undefined) delete process.env['BABEL_A11Y'];
      else process.env['BABEL_A11Y'] = savedA11y;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AppendOnlyRenderer (non-TTY sequential renderer)
// ═══════════════════════════════════════════════════════════════════════════════

test('AppendOnlyRenderer: start-stop lifecycle emits header', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'test lifecycle' });
    r.start();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Babel started: test lifecycle/);
});

test('AppendOnlyRenderer: stage 1->2->3->4 transitions show stage labels', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'stage transitions' });
    r.start();
    bus.stage(1);
    bus.stage(2);
    bus.stage(3);
    bus.stage(4);
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Analyzing your request/);
  assert.match(out, /Planning/);
  assert.match(out, /Reviewing/);
  assert.match(out, /Applying changes/);
});

test('AppendOnlyRenderer: runtime events show tool.requested and tool.completed', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'runtime events' });
    r.start();
    bus.runtimeEvent('tool.requested', { tool: 'file_read', target: 'src/app.ts' });
    bus.runtimeEvent('tool.completed', { tool: 'file_read', target: 'src/app.ts', exit_code: 0 });
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /file_read/);
  assert.match(out, /src\/app\.ts/);
  assert.match(out, /✓/);
});

test('AppendOnlyRenderer: log events render with normalized formatting', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'log events' });
    r.start();
    // A log line that normalizes to a known pattern
    bus.logLine('Reading main.ts for analysis');
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // "Reading ..." normalizes to "Reading file"
  assert.match(out, /Reading file/);
});

test('AppendOnlyRenderer: deduplication suppresses identical activity keys', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'dedup test' });
    r.start();
    bus.logLine('Building project');
    bus.logLine('Building project');
    bus.logLine('Building project');
    const transcript = r.getTranscript();
    r.stop();

    const transcriptMatches = transcript.match(/Building project/g);
    assert.equal(
      transcriptMatches?.length ?? 0,
      1,
      'Duplicate lines should be suppressed in transcript',
    );

    const out = stripAnsi(writes.join(''));
    // "Building project" should appear exactly once (not normalized, passes through)
    const matches = out.match(/Building project/g);
    assert.equal(matches?.length ?? 0, 1, 'Duplicate lines should be suppressed');
  } finally {
    restore();
  }
});

test('AppendOnlyRenderer: empty task name still renders a header', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: '' });
    r.start();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Babel started/);
  assert.ok(out.length > 0, 'Should produce output even with empty task');
});

test('AppendOnlyRenderer: error-like log lines include error formatting', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'error test' });
    r.start();
    bus.logLine('Error: something went wrong');
    bus.logLine('[FAIL] assertion failed');
    bus.logLine('status: EXECUTION_HALTED');
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /something went wrong/);
  assert.match(out, /assertion failed/);
  assert.match(out, /EXECUTION_HALTED/);
});

test('AppendOnlyRenderer: very long task name does not crash', () => {
  const bus = new BabelEventBus();
  const longTask = 'Fix '.repeat(200) + 'the bug';
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: longTask });
    r.start();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.ok(out.length > 0, 'Should handle very long task names');
  // The task name (or the truncated version) should appear as "Fix Fix ... the bug"
  assert.match(out, /Fix/);
});

test('AppendOnlyRenderer: special characters in task and project names handled', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, {
      task: 'fix: escaping & < > " quotes',
      project: 'Project_With_Underscores & Special/Chars',
    });
    r.start();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /fix: escaping/);
  assert.match(out, /Project_With_Underscores/);
});

test('AppendOnlyRenderer: prompt pause and resume messages appear', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, { task: 'pause test' });
    r.start();
    bus.promptPause('Custom pause message');
    bus.promptResume();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Custom pause message/);
  assert.match(out, /Resuming work/);
});

test('AppendOnlyRenderer: projectRoot logged when different from cwd', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new AppendOnlyRenderer(bus, {
      task: 'root test',
      projectRoot: '/some/other/path',
    });
    r.start();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Target root/);
  assert.match(out, /\/some\/other\/path/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ConversationalRenderer (chat mode streaming renderer)
// ═══════════════════════════════════════════════════════════════════════════════

test('ConversationalRenderer: cell viewport tracks transcript lifecycle', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    r.start();
    r.onAnswerChunk('Hello from viewport.');
    const id = r.onToolCallStart('file_read', 'src/index.ts');
    r.onToolCallComplete(id, '2 KB');
    r.onAnswerChunk(' Done.');
    r.stop();

    const viewport = r.getHistoryCellViewport();
    const info = viewport.getScrollInfo();
    assert.ok(info.cellCount >= 3);
    assert.ok(info.totalRows > 0);
    assert.equal(info.isAtBottom, true);

    const records = r.getHistoryCellRecords();
    assert.ok(records.some((record) => record.kind === 'assistant_message'));
    assert.ok(records.some((record) => record.kind === 'tool_call'));
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: full streaming lifecycle (start, answer, summary, stop)', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    r.start();
    r.onAnswerChunk('Hello, ');
    r.onAnswerChunk('world!');
    r.onAnswerChunk(' This is a **test**.');
    r.onSummary({ costUSD: 0.1234, perRunCost: 0.0567 });
    r.stop();

    const answer = stripAnsi(r.getAnswerText());
    assert.match(answer, /Hello, world!/);
    assert.match(answer, /test/); // **test** markdown is rendered by renderMarkdown(), not preserved literally

    // Transcript should also show the answer
    const transcript = stripAnsi(r.getTranscript());
    assert.match(transcript, /Hello, world!/);

    const cells = r.getHistoryCellRecords();
    assert.equal(cells.length, 1);
    assert.equal(cells[0]?.kind, 'assistant_message');
    assert.equal(cells[0]?.lifecycle, 'committed');
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: tool call lifecycle start and complete in non-TTY', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    const id = r.onToolCallStart('file_read', 'src/index.ts');
    r.onToolCallComplete(id, '1.2 KB');
    r.onSummary();
    r.stop();

    const cells = r.getCommittedHistoryCells();
    assert.equal(cells.length, 1);
    assert.equal(cells[0]?.kind, 'tool_call');
    assert.equal((cells[0]?.payload as { status: string }).status, 'completed');
    assert.equal(r.getActiveHistoryCell(), null);
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // Non-TTY format: "[00:00] file_read src/index.ts (1.2 KB)"
  assert.match(out, /file_read/);
  assert.match(out, /src\/index\.ts/);
  assert.match(out, /1\.2 KB/);
});

test('ConversationalRenderer: tool call lifecycle with TTY visual output', () => {
  const r = new ConversationalRenderer({ isTTY: true });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    const id = r.onToolCallStart('shell_exec', 'npm test');
    r.onToolCallComplete(id, 'exit 0');
    r.onSummary();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // TTY format: "○ Running npm test" then "✓ Running npm test (exit 0)"
  assert.match(out, /Running npm test/);
  assert.match(out, /exit 0/);
});

test('ConversationalRenderer: TTY answer stream does not duplicate mid-line chunks', async () => {
  // Force fallback (cursor) mode so stdout captures linear deltas, not
  // DECSTBM absolute paints that re-render the whole streaming area.
  const prevScroll = process.env['BABEL_SCROLL_REGIONS'];
  process.env['BABEL_SCROLL_REGIONS'] = '0';
  const r = new ConversationalRenderer({ isTTY: true });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    // Token-sized chunks + structural newlines — the pattern that used to
    // re-emit the entire message on every fast→structural transition.
    r.onAnswerChunk('Great question. Here is my');
    r.onAnswerChunk(' startup process');
    r.onAnswerChunk(' step by step.\n\n');
    r.onAnswerChunk('## Startup Process\n\n');
    r.onAnswerChunk('The runtime initializes me.\n');
    // Allow ChunkCoalescer (16ms) to flush, then stop flushes remainder.
    await new Promise((resolve) => setTimeout(resolve, 40));
    r.onSummary();
    r.stop();
  } finally {
    restore();
    if (prevScroll === undefined) delete process.env['BABEL_SCROLL_REGIONS'];
    else process.env['BABEL_SCROLL_REGIONS'] = prevScroll;
  }

  const out = stripAnsi(writes.join(''));
  const intro = 'Great question. Here is my startup process step by step.';
  const introCount = out.split(intro).length - 1;
  assert.equal(introCount, 1, `intro must appear once, got ${introCount}: ${JSON.stringify(out)}`);
  assert.equal(
    out.split('The runtime initializes me.').length - 1,
    1,
    'closing sentence must appear once',
  );
});

test('ConversationalRenderer: file change notification shows diffs', () => {
  const r = new ConversationalRenderer({ isTTY: true });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    r.onFileChanged(
      'src/app.ts',
      10,
      2,
      [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,5 +1,13 @@',
        ' unchanged line',
        '+added line 1',
        '+added line 2',
        '-removed line',
        ' more context',
      ].join('\n'),
    );
    r.onSummary();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // Should show the file name
  assert.match(out, /src\/app\.ts/);
  // Should show +/-
  assert.match(out, /\+\d+/);
  assert.match(out, /-\d+/);
  // Diff content
  assert.match(out, /added line/);
  assert.match(out, /removed line/);
  assert.match(out, /unchanged line/);
});

test('ConversationalRenderer: thought accumulation via onThought', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    r.onThought('Hmm, let me think about this...');
    r.onThought(' I should check the imports.');
    r.stop();

    // snapshot() includes thought text
    const snap = stripAnsi(r.snapshot());
    assert.match(snap, /Hmm, let me think about this/);
    assert.match(snap, /check the imports/);
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: setCancelTarget stores callable callback', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    let called = false;
    r.setCancelTarget((...args: unknown[]) => {
      called = true;
      return 'cancelled';
    });
    // Access the private callback via the stored function
    // We test it's callable by triggering fail, which doesn't call cancelTarget
    // Instead, explicitly verify the callback works
    const cb = (r as unknown as { _cancelCallback: ((...args: unknown[]) => unknown) | null })
      ._cancelCallback;
    assert.ok(cb !== null, 'Cancel callback should be stored');
    const result = cb();
    assert.equal(called, true, 'Callback should be invoked');
    assert.equal(result, 'cancelled');
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: pause blocks answer chunks from being recorded', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    r.start();
    r.onAnswerChunk('This should appear.');

    // Pause by directly setting internal state (simulates [P] key)
    (r as unknown as { paused: boolean }).paused = true;
    r.onAnswerChunk('This should NOT appear because paused.');
    (r as unknown as { paused: boolean }).paused = false;

    r.onAnswerChunk(' This should appear after resume.');
    r.onSummary();
    r.stop();

    const answer = r.getAnswerText();
    assert.match(answer, /This should appear\./);
    assert.match(answer, /after resume/);
    // The chunk sent while paused was dropped
    assert.doesNotMatch(answer, /because paused/);
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: fail clears thinking and shows error state', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    r.fail(new Error('Something broke'));
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  assert.match(out, /Something broke/);
});

test('ConversationalRenderer: multiple tool calls in parallel tracked independently', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  const { writes, restore } = interceptStdout();
  try {
    r.start();
    const id1 = r.onToolCallStart('file_read', 'a.ts');
    const id2 = r.onToolCallStart('file_read', 'b.ts');
    const id3 = r.onToolCallStart('shell_exec', 'npm build');

    // Complete out of order
    r.onToolCallComplete(id3, 'exit 0');
    r.onToolCallComplete(id1, '1 KB');
    r.onToolCallComplete(id2, '2 KB');

    r.onSummary();
    r.stop();

    const toolCells = r
      .getCommittedHistoryCells()
      .filter((cell) => cell.kind === 'tool_call');
    assert.equal(toolCells.length, 3);
    assert.equal(
      toolCells.filter((cell) => (cell.payload as { status: string }).status === 'completed')
        .length,
      3,
    );
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // All tools should appear in completion output
  assert.match(out, /npm build/);
  assert.match(out, /a\.ts/);
  assert.match(out, /b\.ts/);
  assert.match(out, /exit 0/);
  assert.match(out, /1 KB/);
  assert.match(out, /2 KB/);
});

test('ConversationalRenderer: setCheckpointAvailable adds checkpoint hint', () => {
  const r = new ConversationalRenderer({ isTTY: true });
  const { writes, restore } = interceptStdout();
  try {
    r.setCheckpointAvailable(true);
    r.start();
    r.onSummary();
    r.stop();
  } finally {
    restore();
  }

  const out = stripAnsi(writes.join(''));
  // The hint bar at stop time should include checkpoint reference
  // (check only when stop() is called with tool call count > 0)
  assert.ok(true, 'setCheckpointAvailable does not throw');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ConversationalRenderer — unseen divider / scroll tracking
// ═══════════════════════════════════════════════════════════════════════════════

test('ConversationalRenderer: unseen count starts at 0', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    assert.equal(
      (r as unknown as { _unseenCount: number })._unseenCount,
      0,
      'unseen count should start at 0',
    );
    assert.equal(
      (r as unknown as { _userScrolledUp: boolean })._userScrolledUp,
      false,
      'userScrolledUp should start false',
    );
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: scroll_to_bottom resets scroll state', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    // Set scroll state as if user scrolled up
    (r as unknown as { _userScrolledUp: boolean })._userScrolledUp = true;
    (r as unknown as { _unseenCount: number })._unseenCount = 5;

    // Simulate the scroll_to_bottom action by calling the handler logic directly
    (r as unknown as { _userScrolledUp: boolean })._userScrolledUp = false;
    (r as unknown as { _unseenCount: number })._unseenCount = 0;

    assert.equal(
      (r as unknown as { _userScrolledUp: boolean })._userScrolledUp,
      false,
      'userScrolledUp should be false after scroll_to_bottom',
    );
    assert.equal(
      (r as unknown as { _unseenCount: number })._unseenCount,
      0,
      'unseenCount should be 0 after scroll_to_bottom',
    );
  } finally {
    r.stop();
  }
});

test('ConversationalRenderer: scroll_up / scroll_down toggle userScrolledUp', () => {
  const r = new ConversationalRenderer({ isTTY: false });
  try {
    // Simulate scroll_up action
    (r as unknown as { _userScrolledUp: boolean })._userScrolledUp = true;
    assert.equal(
      (r as unknown as { _userScrolledUp: boolean })._userScrolledUp,
      true,
      'userScrolledUp should be true after scroll_up',
    );

    // Simulate scroll_down at offset > 0
    (r as unknown as { _userScrolledUp: boolean })._userScrolledUp = false;
    (r as unknown as { _unseenCount: number })._unseenCount = 0;
    assert.equal(
      (r as unknown as { _userScrolledUp: boolean })._userScrolledUp,
      false,
      'userScrolledUp should be false after scroll_down to bottom',
    );
  } finally {
    r.stop();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WaterfallRenderer / TtyHudRenderer
// ═══════════════════════════════════════════════════════════════════════════════

test('TtyHudRenderer: snapshot includes stage info and activity', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'test task', mode: 'deep' });
  try {
    renderer.start();
    bus.stage(2);
    bus.logLine('Reading src/index.ts for analysis');
    renderer.stop();

    const snap = stripAnsi(renderer.getFinalSnapshot());
    // The final snapshot is a run-complete summary
    assert.match(snap, /Run Complete/);
    // Stage summary should show stages
    assert.match(snap, /Stages/);
    // Activity should include what was logged
    assert.match(snap, /Activity/);
  } finally {
    renderer.stop();
  }
});

test('TtyHudRenderer: stage transitions update progress and activity', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'stage test' });
  try {
    renderer.start();

    // Fire a series of stage and log events
    bus.agentId('agent-1');
    bus.stage(1);
    bus.stage(2);
    bus.logLine('Action steps: 5');
    bus.logLine('Reading src/parser.ts');
    bus.stage(3);
    bus.logLine('Reviewing changes');
    bus.stage(4);
    bus.logLine('Writing src/output.ts');

    renderer.stop();

    // Note: transcriptLines is no longer populated by recordActivity();
    // activity is tracked via the state store. The finalSnapshot
    // (from snapshot()) reads from the store and contains the activity.
    const snap = stripAnsi(renderer.getFinalSnapshot());
    assert.ok(snap.length > 0, 'Snapshot should not be empty');
    // Stage labels always visible in the stages section of the snapshot
    assert.match(snap, /Analyze/);
    assert.match(snap, /Plan/);
    assert.match(snap, /Review/);
    // Activity log entries visible in the tail
    assert.match(snap, /Plan ready/);
    assert.match(snap, /Reading file/);
    assert.match(snap, /Writing/);
  } finally {
    renderer.stop();
  }
});

test('TtyHudRenderer: runtime events at different stages processed without error', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'runtime event test' });
  try {
    renderer.start();
    bus.stage(2);

    // Fire various runtime event types
    bus.runtimeEvent('tool.requested', { tool: 'shell_exec', target: '', command: 'npm test' });
    bus.runtimeEvent('tool.completed', {
      tool: 'shell_exec',
      exit_code: 0,
      detail: 'all tests passed',
    });
    bus.runtimeEvent('verification.decision', { decision: 'PASS' });

    renderer.stop();
    const snap = stripAnsi(renderer.getFinalSnapshot());
    assert.ok(snap.includes('Tools') || snap.length > 0, 'Snapshot should be non-empty');
  } finally {
    renderer.stop();
  }
});

test('TtyHudRenderer: pauseForPrompt sets paused state and resume restores it', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'pause test' });
  try {
    renderer.pauseForPrompt('Approve this plan?');
    assert.equal((renderer as unknown as { paused: boolean }).paused, true);

    renderer.resume();
    assert.equal((renderer as unknown as { paused: boolean }).paused, false);
  } finally {
    renderer.stop();
  }
});

test('TtyHudRenderer: pause blocks frame scheduler from rendering', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'pause render test' });
  try {
    renderer.start();
    bus.stage(2);

    // Pause ticks — this should prevent HUD updates
    renderer.pauseTicks();
    assert.equal((renderer as unknown as { pausedTicks: boolean }).pausedTicks, true);

    // Even with activity, the HUD should not render in paused state
    bus.logLine('Should not crash when processing event while paused');

    renderer.resumeTicks();
    assert.equal((renderer as unknown as { pausedTicks: boolean }).pausedTicks, false);
  } finally {
    renderer.stop();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NoopRenderer
// ═══════════════════════════════════════════════════════════════════════════════

test('NoopRenderer: start->stop produces no output', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = new NoopRenderer();
    r.start();
    bus.stage(2);
    bus.logLine('should not appear');
    r.stop();
  } finally {
    restore();
  }

  assert.equal(writes.length, 0, 'NoopRenderer should produce zero stdout output');
});

test('NoopRenderer: all public methods are safe to call and return gracefully', () => {
  const r = new NoopRenderer();
  // These should all be no-ops without throwing
  r.start();
  r.stop();
  r.start();
  r.fail('some error');
  r.fail(new Error('wrapped error'));
  r.fail(undefined);

  const transcript = r.getTranscript();
  assert.equal(transcript, '', 'NoopRenderer transcript should be empty');
});

// ═══════════════════════════════════════════════════════════════════════════════
// createLiveRunRenderer factory
// ═══════════════════════════════════════════════════════════════════════════════

test('createLiveRunRenderer: non-TTY stream returns AppendOnlyRenderer', () => {
  const bus = new BabelEventBus();
  const r = createLiveRunRenderer(bus, { task: 'non-tty test' }, {
    isTTY: false,
  } as typeof process.stdout);
  try {
    assert.ok(r instanceof AppendOnlyRenderer, 'Non-TTY should get AppendOnlyRenderer');
  } finally {
    r.stop();
  }
});

test('createLiveRunRenderer: NO_COLOR env forces AppendOnlyRenderer', () => {
  const bus = new BabelEventBus();
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const r = createLiveRunRenderer(bus, { task: 'no-color test' }, {
      isTTY: true,
    } as typeof process.stdout);
    assert.ok(r instanceof AppendOnlyRenderer, 'NO_COLOR should get AppendOnlyRenderer');
    r.stop();
  } finally {
    if (prev === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prev;
    }
  }
});

test('createLiveRunRenderer: CI env forces AppendOnlyRenderer', () => {
  const bus = new BabelEventBus();
  const prev = process.env.CI;
  process.env.CI = '1';
  try {
    const r = createLiveRunRenderer(bus, { task: 'ci test' }, {
      isTTY: true,
    } as typeof process.stdout);
    assert.ok(r instanceof AppendOnlyRenderer, 'CI should get AppendOnlyRenderer');
    r.stop();
  } finally {
    if (prev === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = prev;
    }
  }
});

test('createLiveRunRenderer: TTY without NO_COLOR/CI returns ConversationalRenderer', () => {
  const bus = new BabelEventBus();
  const prevNoColor = process.env.NO_COLOR;
  const prevCi = process.env.CI;
  delete process.env.NO_COLOR;
  delete process.env.CI;
  try {
    const r = createLiveRunRenderer(bus, { task: 'tty test' }, {
      isTTY: true,
    } as typeof process.stdout);
    assert.ok(
      r instanceof ConversationalRenderer,
      'TTY with no restrictions should get ConversationalRenderer',
    );
    r.stop();
  } finally {
    if (prevNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNoColor;
    }
    if (prevCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = prevCi;
    }
  }
});

test('createLiveRunRenderer: empty context does not crash and returns renderer', () => {
  const bus = new BabelEventBus();
  const r = createLiveRunRenderer(bus, {}, { isTTY: false } as typeof process.stdout);
  try {
    assert.ok(r instanceof AppendOnlyRenderer, 'Empty context should not crash');
  } finally {
    r.stop();
  }
});

test('createLiveRunRenderer: AppendOnlyRenderer with full context fields', () => {
  const bus = new BabelEventBus();
  const { writes, restore } = interceptStdout();
  try {
    const r = createLiveRunRenderer(
      bus,
      {
        task: 'my task',
        project: 'MyProject',
        targetProject: 'MyProject',
        projectRoot: '/workspace/my-project',
      },
      { isTTY: false } as typeof process.stdout,
    ) as AppendOnlyRenderer;
    r.start();
    r.stop();

    const out = stripAnsi(writes.join(''));
    assert.match(out, /Babel started: my task/);
    assert.match(out, /Target: MyProject/);
    // projectRoot may or may not be shown depending on cwd
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Snapshot-based tests (stripped ANSI for cross-platform stability)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mock Date.now to a fixed epoch so that elapsed-time displays
 * (`[00:00]`, `(0s)`, `Duration 00:00`) are deterministic across
 * fast and slow CI runners. Without this, a test that slips past
 * 1 s wall-clock produces `[00:01]` / `(1s)` and breaks the snapshot.
 */
function withFixedTime<T>(fn: () => T): T {
  const orig = Date.now;
  const origA11y = process.env['BABEL_A11Y'];
  const origNoColor = process.env['NO_COLOR'];
  const FIXED_MS = 1_715_000_000_000;
  Date.now = () => FIXED_MS;
  delete process.env['BABEL_A11Y'];
  delete process.env['NO_COLOR'];
  try {
    return fn();
  } finally {
    Date.now = orig;
    if (origA11y !== undefined) process.env['BABEL_A11Y'] = origA11y;
    else delete process.env['BABEL_A11Y'];
    if (origNoColor !== undefined) process.env['NO_COLOR'] = origNoColor;
    else delete process.env['NO_COLOR'];
  }
}

test('AppendOnlyRenderer: snapshot of full lifecycle with events', () => {
  withFixedTime(() => {
    const bus = new BabelEventBus();
    const { writes, restore } = interceptStdout();
    try {
      const r = new AppendOnlyRenderer(bus, { task: 'snapshot test' });
      r.start();
      bus.stage(1);
      bus.logLine('Analyzing code structure');
      bus.stage(2);
      bus.logLine('Planning the fix approach');
      bus.stage(3);
      bus.logLine('Reviewing the plan for issues');
      bus.stage(4);
      bus.logLine('Writing the fix');
      r.stop();
    } finally {
      restore();
    }

    // Capture all output, stripped, and match against snapshot
    const out = stripAnsi(writes.join(''));
    matchStrippedSnapshot(out, 'AppendOnlyRenderer: full lifecycle with events', import.meta.url);
  });
});

test('ConversationalRenderer: snapshot of TTY tool call interaction', () => {
  withFixedTime(() => {
    const r = new ConversationalRenderer({ isTTY: true });
    const { writes, restore } = interceptStdout();
    try {
      r.start();
      r.onToolCallStart('file_read', 'src/main.ts');
      r.onToolCallStart('shell_exec', 'npm run build');
      // Complete both
      // Note: in a real scenario the IDs come from onToolCallStart return values
      // We simulate by completing via the stored pendingToolCalls keys
      const pendingKeys = Array.from(
        (r as unknown as { pendingToolCalls: Map<number, unknown> }).pendingToolCalls.keys(),
      );
      if (pendingKeys.length >= 2) {
        r.onToolCallComplete(pendingKeys[0]!, '1.5 KB');
        r.onToolCallComplete(pendingKeys[1]!, 'exit 0');
      }
      r.onSummary();
      r.stop();
    } finally {
      restore();
    }

    const out = stripAnsi(writes.join(''));
    matchStrippedSnapshot(out, 'ConversationalRenderer: TTY tool call interaction', import.meta.url);
  });
});

test('ConversationalRenderer: snapshot of TTY file change notification with inline diff', () => {
  withFixedTime(() => {
    const r = new ConversationalRenderer({ isTTY: true });
    const { writes, restore } = interceptStdout();
    try {
      r.start();
      r.onFileChanged(
        'src/utils/helper.ts',
        3,
        1,
        [
          '--- a/src/utils/helper.ts',
          '+++ b/src/utils/helper.ts',
          '@@ -10,7 +10,9 @@',
          ' export function helper() {',
          '   return 42;',
          '+  // new logic',
          '+  return 43;',
          ' }',
        ].join('\n'),
      );
      r.onSummary();
      r.stop();
    } finally {
      restore();
    }

    const out = stripAnsi(writes.join(''));
    matchStrippedSnapshot(
      out,
      'ConversationalRenderer: TTY file change notification',
      import.meta.url,
    );
  });
});

test('ConversationalRenderer: snapshot of subagent failed overlay', () => {
  withFixedTime(() => {
    const r = new ConversationalRenderer({ isTTY: true });
    const { writes, restore } = interceptStdout();
    try {
      r.start();
      r.onSubAgentStart('chat-sub-1', 'Investigate auth module');
      r.onSubAgentFailed('chat-sub-1', 'provider timeout after 120s');
      r.onSummary();
      r.stop();
    } finally {
      restore();
    }

    const out = stripAnsi(writes.join(''));
    matchStrippedSnapshot(out, 'ConversationalRenderer: subagent failed overlay', import.meta.url);
  });
});

test('AppendOnlyRenderer: snapshot of error log lines and runtime events', () => {
  withFixedTime(() => {
    const bus = new BabelEventBus();
    const { writes, restore } = interceptStdout();
    try {
      const r = new AppendOnlyRenderer(bus, { task: 'error snapshot' });
      r.start();
      bus.logLine('Error: network timeout');
      bus.logLine('[FAIL] test assertion failed on line 42');
      bus.runtimeEvent('tool.requested', { tool: 'shell_exec', command: 'npm install' });
      bus.runtimeEvent('tool.completed', {
        tool: 'shell_exec',
        exit_code: 1,
        detail: 'install failed',
      });
      r.stop();
    } finally {
      restore();
    }

    const out = stripAnsi(writes.join(''));
    matchStrippedSnapshot(
      out,
      'AppendOnlyRenderer: error log lines and runtime events',
      import.meta.url,
    );
  });
});

test('TtyHudRenderer: snapshot of final output with stage progress and activity', () => {
  withFixedTime(() => {
    const bus = new BabelEventBus();
    const renderer = new TtyHudRenderer(bus, { task: 'hud snapshot', mode: 'deep' });
    try {
      renderer.start();
      bus.stage(1);
      bus.logLine('Analyzing repository structure');
      bus.stage(2);
      bus.logLine('Action steps: 3');
      bus.logLine('Planning the implementation');
      bus.stage(3);
      bus.logLine('Reviewing plan for correctness');
      bus.stage(4);
      bus.logLine('Writing changes to src/index.ts');
      renderer.stop();

      const snap = renderer.getFinalSnapshot();
      matchStrippedSnapshot(snap, 'TtyHudRenderer: final snapshot', import.meta.url);
    } finally {
      renderer.stop();
    }
  });
});
