/**
 * tui_benchmark.ts — TUI Render Performance Benchmark (R4.6/G2).
 *
 * Measures FrameScheduler frame timing under a fixed render scenario.
 * Used as a CI regression gate to ensure TUI render performance stays
 * within 60fps budget (<16ms average, <100ms max per frame).
 *
 * The benchmark registers simulated render callbacks (HUD, content, spinner)
 * that approximate real TUI workload, lets the scheduler run for a fixed
 * duration, then asserts on the recorded FrameMetrics.
 *
 * Usage:
 *   npm run benchmark:tui
 *   npm run benchmark:tui -- --duration 2000  (custom duration in ms)
 */

import { FrameScheduler } from '../src/ui/frameScheduler.js';

interface BenchmarkOptions {
  duration: number;
  help: boolean;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const opts: BenchmarkOptions = { duration: 1000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--duration') {
      opts.duration = Number.parseInt(argv[++i] ?? '1000', 10);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm run benchmark:tui [options]',
    '',
    'Options:',
    '  --duration <ms>  Benchmark duration in ms (default: 1000)',
    '  --help, -h       Show this help',
    '',
    'The benchmark registers simulated render callbacks, lets the scheduler',
    'run for the specified duration, then asserts on FrameMetrics:',
    '  - Average render duration < 16ms (60fps target)',
    '  - Max render duration < 100ms',
    '',
  ].join('\n') + '\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const scheduler = FrameScheduler.getInstance();
  scheduler.resetForTest();

  // ── Register simulated render callbacks ──────────────────────────────────

  // HUD-like rendering: builds status display with styled lines
  scheduler.scheduleComponent('bench-hud', () => {
    let out = '';
    for (let i = 0; i < 5; i++) {
      out += `\x1b[36mStatus: \x1b[0m${i === 0 ? 'Running' : 'Idle'}\n`;
    }
  }, { label: 'hud-renderer' });

  // Content-like rendering: builds output lines with ANSI styles
  scheduler.scheduleComponent('bench-content', () => {
    let out = '';
    for (let i = 0; i < 20; i++) {
      out += `\x1b[32m[INFO]\x1b[0m line ${i}: sample output with \x1b[1mbold\x1b[0m styles\n`;
    }
  }, { label: 'content-renderer' });

  // Spinner-like rendering: builds animated progress indicator
  scheduler.scheduleComponent('bench-spinner', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const f = frames[Math.floor(Math.random() * frames.length)];
    // Build spinner line (avoid unused var lint)
    void `\x1b[33m${f} Processing...\x1b[0m`;
  }, { label: 'spinner-renderer' });

  // Stats-like rendering: builds compact data display
  scheduler.scheduleComponent('bench-stats', () => {
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += `${i}: \x1b[1m${100 - i * 10}%\x1b[0m \x1b[2m████████░░\x1b[0m\n`;
    }
  }, { label: 'stats-renderer' });

  // Mark all components as permanently dirty so they fire every frame
  for (const id of ['bench-hud', 'bench-content', 'bench-spinner', 'bench-stats']) {
    scheduler.setComponentPermanentDirty(id, true);
  }

  // ── Run benchmark ────────────────────────────────────────────────────────

  process.stderr.write(`TUI benchmark running for ${opts.duration}ms...\n`);

  await new Promise<void>((resolve) => setTimeout(resolve, opts.duration));

  // ── Collect and report metrics ───────────────────────────────────────────

  const metrics = scheduler.getFrameHistory();
  const avgDuration = scheduler.getAverageRenderDuration();
  const maxDuration = metrics.length > 0
    ? Math.max(...metrics.map((m) => m.renderDurationMs))
    : 0;
  const frameCount = metrics.length > 0 ? metrics.length : 0;
  const framesPerSecond = opts.duration > 0
    ? Math.round((frameCount / opts.duration) * 1000)
    : 0;

  const result = {
    benchmark: 'tui-render',
    durationMs: opts.duration,
    framesRecorded: frameCount,
    framesPerSecond,
    avgRenderDurationMs: avgDuration,
    maxRenderDurationMs: maxDuration,
    thresholdAvgMs: 16,
    thresholdMaxMs: 100,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  // ── Assert thresholds ────────────────────────────────────────────────────

  let failed = false;

  if (avgDuration >= 16) {
    process.stderr.write(
      `FAIL: Average render duration ${avgDuration}ms exceeds 16ms threshold\n`,
    );
    failed = true;
  }

  if (maxDuration >= 100) {
    process.stderr.write(
      `FAIL: Max render duration ${maxDuration}ms exceeds 100ms threshold\n`,
    );
    failed = true;
  }

  if (frameCount === 0) {
    process.stderr.write('FAIL: No frames were recorded by the scheduler\n');
    failed = true;
  }

  scheduler.resetForTest();

  if (failed) {
    process.stderr.write('TUI render benchmark FAILED\n');
    process.exit(1);
  }

  process.stderr.write('TUI render benchmark PASSED\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `TUI benchmark fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
