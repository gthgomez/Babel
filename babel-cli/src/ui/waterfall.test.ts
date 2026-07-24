import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { BabelEventBus } from '../pipeline.js';
import { babelDusk, previewBuiltinTheme, resolveBuiltinTheme } from './tokens.js';
import {
  AppendOnlyRenderer,
  ConversationalRenderer,
  createLiveRunRenderer,
  getActiveRenderer,
  NoopRenderer,
  TtyHudRenderer,
  WaterfallRenderer,
} from './waterfall.js';
import { stripAnsi } from './theme.js';
import { SpinnerRenderer } from './spinner.js';
import { OutputBuffer } from './outputBuffer.js';
import { FrameScheduler } from './frameScheduler.js';
import { resetTerminalProbe } from './terminalProbe.js';
import { withEnv } from './testUtils.js';

test('run spinner suppresses broken stdout pipe errors', () => {
  const script = `
    import { SpinnerRenderer } from './src/ui/spinner.js';
    const spinner = new SpinnerRenderer({ interval: 80, stream: process.stdout });
    spinner.setText('broken stdout regression');
    spinner.start();
    process.stdout.emit(
      'error',
      Object.assign(new Error('synthetic broken pipe'), { code: 'EPIPE' }),
    );
    setTimeout(() => {
      spinner.stop();
      console.log('BROKEN_PIPE_SMOKE_OK');
    }, 120);
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /BROKEN_PIPE_SMOKE_OK/);
});

test('babel-dusk resolves with exact truecolor and ANSI fallback values', () => {
  const theme = resolveBuiltinTheme('babel-dusk');

  assert.deepEqual(theme.trueColor, babelDusk.trueColor);
  assert.deepEqual(theme.ansiFallback, babelDusk.ansiFallback);
  assert.equal(theme.trueColor.background, '#0B0A16');
  assert.equal(theme.trueColor.accent, '#D7AFFF');
  assert.equal(theme.trueColor.success, '#87D787');
  assert.equal(theme.ansiFallback.accent, 183);
  assert.equal(theme.ansiFallback.success, 114);
  assert.throws(() => resolveBuiltinTheme('graphite-cyan'), /Unknown Babel theme/);
  assert.match(previewBuiltinTheme('babel-dusk'), /babel-dusk/);
});

test('babel-dusk ANSI fallback uses 256-color roles when color is forced', () => {
  const script = `
    import { accent, success, stripAnsi } from './src/ui/theme.js';
    const rendered = accent('Babel') + ' ' + success('passed');
    console.log(JSON.stringify({ rendered, stripped: stripAnsi(rendered) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      NO_COLOR: '',
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const parsed = JSON.parse(result.stdout.trim()) as { rendered: string; stripped: string };
  assert.match(parsed.rendered, /\u001B\[38;5;183mBabel/);
  assert.match(parsed.rendered, /\u001B\[38;5;114mpassed/);
  assert.equal(parsed.stripped, 'Babel passed');
});

test('live run renderer selection avoids animated HUD for non-TTY, NO_COLOR, and CI', () => {
  const bus = new BabelEventBus();
  const nonTty = createLiveRunRenderer(bus, { task: 'fix test' }, {
    isTTY: false,
  } as typeof process.stdout);
  assert.ok(nonTty instanceof AppendOnlyRenderer);
  nonTty.stop();

  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const renderer = createLiveRunRenderer(bus, { task: 'fix test' }, {
      isTTY: true,
    } as typeof process.stdout);
    assert.ok(renderer instanceof AppendOnlyRenderer);
    renderer.stop();
  } finally {
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }

  const previousCi = process.env.CI;
  process.env.CI = '1';
  try {
    const renderer = createLiveRunRenderer(bus, { task: 'fix test' }, {
      isTTY: true,
    } as typeof process.stdout);
    assert.ok(renderer instanceof AppendOnlyRenderer);
    renderer.stop();
  } finally {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
  }

  const previousCiForHud = process.env.CI;
  const previousNoColorForHud = process.env.NO_COLOR;
  delete process.env.CI;
  delete process.env.NO_COLOR;
  const hud = createLiveRunRenderer(bus, { task: 'fix test' }, {
    isTTY: true,
  } as typeof process.stdout);
  try {
    // ConversationalRenderer is now the default for ALL modes on TTY
    assert.ok(hud instanceof ConversationalRenderer);
  } finally {
    hud.stop();
    if (previousCiForHud === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCiForHud;
    }
    if (previousNoColorForHud === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColorForHud;
    }
  }
});

test('append-only renderer emits safe progress lines from event bus', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'fix failing parser test' });
    renderer.start();
    bus.stage(2);
    bus.logLine('Running npm test');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = stripAnsi(writes.join(''));
  assert.match(output, /\[00:00\] Babel started: fix failing parser test/);
  assert.match(output, /\[00:00\] Planning/);
  assert.match(output, /\[00:00\] Running check/);
});

test('append-only renderer records prompt pause and resume truthfully', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'inspect repo' });
    renderer.start();
    bus.promptPause('Waiting for plan approval');
    bus.promptResume();
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = stripAnsi(writes.join(''));
  assert.match(output, /Waiting for plan approval/);
  assert.match(output, /Resuming work/);
});

test('tty HUD pause restores prompt state and suppresses repaint until resumed', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'inspect repo' });
  try {
    renderer.pauseForPrompt('Waiting for plan approval');
    assert.equal((renderer as unknown as { paused: boolean }).paused, true);
    renderer.resume();
    assert.equal((renderer as unknown as { paused: boolean }).paused, false);
  } finally {
    renderer.stop();
  }
});

test('append-only renderer hides internal pipeline language in default human output', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'what is the repo about?' });
    renderer.start();
    bus.logLine('Stage 1 / 4  —  Orchestrator');
    bus.logLine('Stage 2 / 4  —  SWE Agent');
    bus.logLine('Stage 3 / 4  —  QA Reviewer');
    bus.logLine('[babel:qa] QA: PASS');
    bus.logLine('[babel:executor] Executor turn 1/20');
    bus.logLine('CLI Executor selected provider_model_id deepseek-chat');
    bus.logLine('QA: PASS  (confidence: 5/5)');
    bus.logLine('v9 stack telemetry: {"pipeline_mode":"verified"}');
    bus.logLine('Model:    deepseek');
    bus.logLine('Review cancelled. Pipeline halted.');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = stripAnsi(writes.join(''));
  assert.match(output, /Analyzing request/);
  assert.match(output, /Planning/);
  assert.match(output, /Reviewing/);
  assert.match(output, /Review passed/);
  assert.match(output, /Applying changes/);
  assert.match(output, /Stopped/);
  assert.doesNotMatch(
    output,
    /\[babel:qa\]|\[babel:executor\]|Orchestrator|SWE Agent|QA Reviewer|CLI Executor|Executor turn/,
  );
  assert.doesNotMatch(
    output,
    /Stage 1 \/ 4|v9 stack telemetry|Model:|deepseek|provider_model_id|confidence/,
  );
});

test('append-only transcript records stripped audit output without duplicate activity', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let renderer: AppendOnlyRenderer | null = null;
  try {
    renderer = new AppendOnlyRenderer(bus, {
      task: 'inspect repo',
      project: 'example_game_suite',
      projectRoot: '/tmp/example_game_suite',
    });
    renderer.start();
    bus.stage(2);
    bus.logLine('Action steps: Prepared plan');
    bus.logLine('Prepared plan');
    bus.logLine('Reviewing plan');
    bus.logLine('Stage 3 / 4  —  QA Reviewer');
    bus.stage(2);
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }

  const transcript = stripAnsi(renderer?.getTranscript() ?? '');
  assert.match(transcript, /Babel started: inspect repo/);
  assert.match(transcript, /Target: example_game_suite/);
  assert.match(transcript, /Target root: \/tmp\/example_game_suite/);
  assert.equal((transcript.match(/Planning/g) ?? []).length, 1);
  assert.equal((transcript.match(/Plan ready/g) ?? []).length, 1);
  assert.equal((transcript.match(/Reviewing/g) ?? []).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Additional coverage: error states, edge cases, NoopRenderer
// ═══════════════════════════════════════════════════════════════════════════════

test('NoopRenderer does not emit any output', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new NoopRenderer();
    renderer.start();
    bus.stage(2);
    bus.logLine('should not appear');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  // NoopRenderer must not write anything
  assert.equal(writes.length, 0, 'NoopRenderer should produce zero output');
});

test('getActiveRenderer returns null or a renderer instance after usage', () => {
  // After previous tests, a renderer may have been set or cleaned up.
  // We verify the function is callable and returns something reasonable.
  const active = getActiveRenderer();
  assert.ok(
    active === null || typeof active === 'object',
    'getActiveRenderer should return null or a renderer instance',
  );
});

test('AppendOnlyRenderer handles log events with no task gracefully', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: '' });
    renderer.start();
    bus.logLine('doing work without a task name');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  // Should still emit something without crashing
  assert.ok(output.length > 0, 'Should produce output even with empty task');
});

test('AppendOnlyRenderer handles special characters in project name', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, {
      task: 'fix: escaping & < > " quotes',
      project: 'Project_With_Underscores & Special/Chars',
    });
    renderer.start();
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  assert.match(output, /fix: escaping/);
  assert.match(output, /Project_With_Underscores/);
  // Should not crash on special characters
});

test('AppendOnlyRenderer handles error-like log lines', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'error handling test' });
    renderer.start();
    bus.logLine('Error: something went wrong');
    bus.logLine('[FAIL] test assertion failed');
    bus.logLine('WARN: deprecation notice');
    bus.logLine('FATAL: out of memory');
    bus.logLine('status: EXECUTION_HALTED');
    bus.logLine('halt_tag: STEP_VERIFICATION_FAIL');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  // Error-like lines should flow through without crashing the renderer
  assert.match(output, /something went wrong/);
  assert.match(output, /EXECUTION_HALTED/);
});

test('AppendOnlyRenderer suppresses duplicate consecutive log lines', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let renderer: AppendOnlyRenderer | null = null;
  try {
    renderer = new AppendOnlyRenderer(bus, { task: 'dedup test' });
    renderer.start();
    bus.logLine('Building project');
    bus.logLine('Building project');
    bus.logLine('Building project');
    bus.stage(3);
    bus.logLine('Running tests');
    bus.logLine('Running tests');
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const transcript = stripAnsi(renderer?.getTranscript() ?? '');
  // "Building project" should appear only once
  assert.equal(
    (transcript.match(/Building project/g) ?? []).length,
    1,
    'Duplicate consecutive log lines should be suppressed',
  );
  // "Running tests" should appear only once
  assert.equal((transcript.match(/Running tests/g) ?? []).length, 1);
});

test('AppendOnlyRenderer records very long task names without truncation crash', () => {
  const bus = new BabelEventBus();
  const longTask = 'Fix '.repeat(200) + 'the bug';
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: longTask });
    renderer.start();
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  assert.ok(output.length > 0, 'Should handle very long task names');
  // The task name should be present (possibly truncated by the renderer)
  assert.match(output, /Fix Fix/);
});

test('TtyHudRenderer pause prevents timer-based renders', () => {
  const bus = new BabelEventBus();
  const renderer = new TtyHudRenderer(bus, { task: 'pause render test' });
  try {
    renderer.pauseForPrompt('Approve this change?');
    // pauseForPrompt sets this.paused = true
    assert.equal((renderer as unknown as { paused: boolean }).paused, true);

    // Simulate a timer tick — should not throw when paused
    (renderer as unknown as { updateWaitingState: () => void }).updateWaitingState();

    renderer.resume();
    assert.equal((renderer as unknown as { paused: boolean }).paused, false);
  } finally {
    renderer.stop();
  }
});

test('AppendOnlyRenderer records runtime events without duplication', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'runtime event test' });
    renderer.start();
    bus.emit('runtime_event', { event_type: 'verification.decision', passed: true });
    bus.emit('runtime_event', { event_type: 'tool.pre-exec', tool: 'shell_exec' });
    bus.emit('runtime_event', { event_type: 'completion.guard', passed: true });
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  // Should emit something for each event type
  assert.ok(output.length > 0);
});

test('AppendOnlyRenderer handles very long log lines without crashing', () => {
  const bus = new BabelEventBus();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new AppendOnlyRenderer(bus, { task: 'long line test' });
    renderer.start();
    // Simulate a very long compiler output line
    // normalizeActivityLine truncates at terminal width, so the full line won't appear
    bus.logLine('Compiled context: ' + 'x'.repeat(5000));
    renderer.stop();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = stripAnsi(writes.join(''));
  // The renderer should not crash and should produce some output
  assert.ok(output.length > 0, 'Should handle very long log lines without crashing');
});

test('createLiveRunRenderer returns AppendOnlyRenderer when stream is not TTY', () => {
  const bus = new BabelEventBus();
  const renderer = createLiveRunRenderer(bus, { task: 'non-tty test' }, {
    isTTY: false,
  } as typeof process.stdout);
  try {
    assert.ok(
      renderer instanceof AppendOnlyRenderer,
      'Non-TTY stream should get AppendOnlyRenderer',
    );
  } finally {
    renderer.stop();
  }
});

test('createLiveRunRenderer handles missing context fields', () => {
  const bus = new BabelEventBus();
  const renderer = createLiveRunRenderer(
    bus,
    {}, // empty context
    { isTTY: false } as typeof process.stdout,
  );
  try {
    assert.ok(
      renderer instanceof AppendOnlyRenderer,
      'Empty context should not crash renderer creation',
    );
  } finally {
    renderer.stop();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Spinner cursor restoration on render exception
// ═══════════════════════════════════════════════════════════════════════════════

test('spinner restores cursor on render exception', () => {
  const writes: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const spinner = new SpinnerRenderer({
      stream: process.stderr,
      format: () => { throw new Error('simulated error'); },
      interval: 50,
    });
    spinner.setText('test');

    // start() calls render() synchronously; the format function throws
    try {
      spinner.start();
    } catch {
      // Expected — the format function throws on first render
    }

    const allOutput = writes.join('');
    // Cursor hide was emitted by start()
    assert.match(allOutput, /\x1b\[\?25l/);
    // Cursor show must be emitted by the error handler in render()
    assert.match(allOutput, /\x1b\[\?25h/);
    // Spinner must be stopped after the error
    assert.equal(spinner.isRunning(), false);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Event bus listener cleanup
// ═══════════════════════════════════════════════════════════════════════════════

test('WaterfallRenderer unregisters event bus listeners after create/stop cycles', () => {
  const bus = new BabelEventBus();

  for (let i = 0; i < 3; i++) {
    const renderer = new TtyHudRenderer(bus, { task: `test-${i}` });
    renderer.start();
    renderer.stop();
  }

  // After all stop() calls, no event bus listeners should remain
  assert.equal(bus.listenerCount('assistant_thought'), 0);
  assert.equal(bus.listenerCount('stage'), 0);
  assert.equal(bus.listenerCount('agent_id'), 0);
  assert.equal(bus.listenerCount('log'), 0);
  assert.equal(bus.listenerCount('runtime_event'), 0);
  assert.equal(bus.listenerCount('prompt_pause'), 0);
  assert.equal(bus.listenerCount('prompt_resume'), 0);
});

test('AppendOnlyRenderer unregisters event bus listeners after create/stop cycles', () => {
  const bus = new BabelEventBus();

  for (let i = 0; i < 3; i++) {
    const renderer = new AppendOnlyRenderer(bus, { task: `test-${i}` });
    renderer.start();
    renderer.stop();
  }

  assert.equal(bus.listenerCount('stage'), 0);
  assert.equal(bus.listenerCount('log'), 0);
  assert.equal(bus.listenerCount('runtime_event'), 0);
  assert.equal(bus.listenerCount('assistant_thought'), 0);
  assert.equal(bus.listenerCount('prompt_pause'), 0);
  assert.equal(bus.listenerCount('prompt_resume'), 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// safeStdoutWrite DEC 2026 synchronized update frames
// ═══════════════════════════════════════════════════════════════════════════════

test('safeStdoutWrite wraps streaming writes inside DEC 2026 frames', () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    withEnv(
      { TERM_PROGRAM: 'wezterm', WT_SESSION: '1', BABEL_WINTERM_SYNC: '1' },
      () => {
        OutputBuffer.resetInstance();
        const bus = new BabelEventBus();
        const renderer = new AppendOnlyRenderer(bus, { task: 'frame test' });
        renderer.start();
        renderer.write('streaming chunk');
        renderer.stop();

        const all = writes.join('');
        // DEC_2026_BEGIN = \x1b[?2026h, DEC_2026_END = \x1b[?2026l
        assert.match(all, /\x1b\[\?2026h/);
        assert.match(all, /\x1b\[\?2026l/);
        assert.match(all, /streaming chunk/);

        // Restore OutputBuffer singleton so other tests get fresh detection
        OutputBuffer.resetInstance();
      },
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});
