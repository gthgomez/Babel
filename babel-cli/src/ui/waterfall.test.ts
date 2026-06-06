import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { BabelEventBus } from '../pipeline.js';
import { babelDusk, previewBuiltinTheme, resolveBuiltinTheme } from './tokens.js';
import { AppendOnlyRenderer, createLiveRunRenderer, TtyHudRenderer } from './waterfall.js';
import { stripAnsi } from './theme.js';

test('run spinner suppresses broken stdout pipe errors', () => {
  const script = `
    import { createRunSpinner } from './src/ui/waterfall.js';
    const spinner = createRunSpinner('broken stdout regression');
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
  const nonTty = createLiveRunRenderer(bus, { task: 'fix test' }, { isTTY: false } as typeof process.stdout);
  assert.ok(nonTty instanceof AppendOnlyRenderer);
  nonTty.stop();

  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const renderer = createLiveRunRenderer(bus, { task: 'fix test' }, { isTTY: true } as typeof process.stdout);
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
    const renderer = createLiveRunRenderer(bus, { task: 'fix test' }, { isTTY: true } as typeof process.stdout);
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
  delete process.env.CI;
  const hud = createLiveRunRenderer(bus, { task: 'fix test' }, { isTTY: true } as typeof process.stdout);
  try {
    assert.ok(hud instanceof TtyHudRenderer);
  } finally {
    hud.stop();
    if (previousCiForHud === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCiForHud;
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
  assert.match(output, /\[00:00\] Planning change/);
  assert.match(output, /\[00:00\] Running verifier/);
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
  assert.match(output, /Routing request/);
  assert.match(output, /Planning change/);
  assert.match(output, /Reviewing plan/);
  assert.match(output, /Review passed/);
  assert.match(output, /Applying change/);
  assert.match(output, /Run blocked/);
  assert.doesNotMatch(output, /\[babel:qa\]|\[babel:executor\]|Orchestrator|SWE Agent|QA Reviewer|CLI Executor|Executor turn/);
  assert.doesNotMatch(output, /Stage 1 \/ 4|v9 stack telemetry|Model:|deepseek|provider_model_id|confidence/);
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
      projectRoot: '/workspace-root/example_game_suite',
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
  assert.match(transcript, /Target root: C:\/Workspace\/example_game_suite/);
  assert.equal((transcript.match(/Planning change/g) ?? []).length, 1);
  assert.equal((transcript.match(/Prepared plan/g) ?? []).length, 1);
  assert.equal((transcript.match(/Reviewing plan/g) ?? []).length, 1);
});
