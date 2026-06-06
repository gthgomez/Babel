import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const cliRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(cliRoot, '..');
const smokeRoot = mkdtempSync(join(tmpdir(), 'babel-interactive-smoke-'));
const eventsPath = join(smokeRoot, 'events.jsonl');
const runsDir = join(smokeRoot, 'runs');
const tsxBin = join(cliRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(
  process.execPath,
  [tsxBin, '--no-warnings=ExperimentalWarning', join(cliRoot, 'src', 'index.ts'), 'interactive', '--mode', 'verified'],
  {
    cwd: smokeRoot,
    env: {
      ...process.env,
      BABEL_ROOT: repoRoot,
      BABEL_RUNS_DIR: runsDir,
      NODE_NO_WARNINGS: '1',
      BABEL_EVENTS_JSONL: eventsPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => { stdout += chunk; });
child.stderr.on('data', (chunk: string) => { stderr += chunk; });

child.stdin.write('/help\n');
child.stdin.write('/status\n');
child.stdin.write('/tools\n');
child.stdin.write('/checkpoint\n');
child.stdin.write('/session\n');
child.stdin.write('/agents\n');
child.stdin.write('/stats\n');
child.stdin.write('/q\n');
child.stdin.end();

const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('interactive smoke timed out'));
  }, 20_000);
  child.on('error', reject);
  child.on('exit', (code) => {
    clearTimeout(timeout);
    resolvePromise(code);
  });
});

assert(exitCode === 0, `interactive smoke exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
assert(stdout.includes('Interactive Command Guide'), 'interactive help did not render workflow guide');
assert(stdout.includes('Daily path: /doctor -> /status -> type a task'), 'interactive help did not include daily path');
assert(stdout.includes('/checkpoint'), 'interactive help did not include /checkpoint');
assert(stdout.includes('/restore'), 'interactive help did not include /restore');
assert(stdout.includes('/session'), 'interactive help did not include /session');
assert(stdout.includes('/agents'), 'interactive help did not include /agents');
assert(stdout.includes('Session State'), 'interactive /status did not render session state');
assert(stdout.includes('Local Tools'), 'interactive /tools did not render tool list');
assert(stdout.includes('No recent run is available.'), 'interactive recovery commands did not route through run resolver');
assert(stdout.includes('Babel Agent Team Runs'), 'interactive /agents did not render agent list');
assert(stdout.includes('Session Stats'), 'interactive /stats did not render session stats');
assert(existsSync(eventsPath) === false, 'event stream should not be created before a task run');

console.log('interactive REPL smoke checks passed');
