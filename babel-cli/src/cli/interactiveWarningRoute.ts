import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

let warningRouteFailure: string | undefined;
export function getWarningRouteFailure(): string | undefined { return warningRouteFailure; }

/** Redirect Node warnings before importing the interactive runtime's WASM. */
export async function routeInteractiveWarnings({
  argv = process.argv,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
}: { argv?: string[]; isTTY?: boolean } = {}): Promise<boolean> {
  const args = argv.slice(2);
  if (!isTTY || process.env['BABEL_HEADLESS'] === '1' || (args.length > 0 && args[0] !== 'interactive') ||
      args.some((a) => ['--help', '-h', '--version', '--json', '--headless'].includes(a)) ||
      process.env['NODE_REDIRECT_WARNINGS'] || /(?:^|\s)--(?:redirect-warnings|inspect\S*|watch)(?:[=\s]|$)/.test(process.env['NODE_OPTIONS'] ?? '') ||
      process.execArgv.some((a) => /^--(?:redirect-warnings|inspect|watch)/.test(a))) return false;
  const entry = argv[1];
  if (!entry) return false;
  const root = resolve(process.env['BABEL_STATE_DIR'] || join(process.env['USERPROFILE'] || process.env['HOME'] || homedir(), '.babel'));
  const directory = join(root, 'diagnostics');
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch {
    warningRouteFailure = 'Warning log directory unavailable. Check the user state directory permissions; Node warnings use stderr.';
    return false;
  }
  const warningLog = join(directory, `node-warnings-${process.pid}.log`);
  const child = spawn(process.execPath, [...process.execArgv, `--redirect-warnings=${warningLog}`, entry, ...args], { stdio: 'inherit' });
  // The foreground child receives terminal Ctrl+C too and owns cancellation.
  // Keep the launcher alive until that child exits; forward targeted termination.
  const interrupt = (): void => {};
  const terminate = (): void => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  return true;
}
