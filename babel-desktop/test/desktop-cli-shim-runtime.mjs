/**
 * Shared Desktop CLI shim: redirects `remote serve` → acceptance-bridge and
 * forwards SIGTERM/SIGINT to the owned dist child (bounded tree kill).
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHIM_STOP_GRACE_MS = 2_500;

function terminateOwnedTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 1500,
      });
    } catch {
      /* close still reports exit */
    }
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* group may already be gone */
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* group may already be gone */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

let ownedRemoteChild = null;
let shimShuttingDown = false;

function shutdownShimOwnedChild() {
  if (shimShuttingDown) return;
  shimShuttingDown = true;
  const child = ownedRemoteChild;
  if (!child) {
    process.exit(0);
    return;
  }
  terminateOwnedTree(child);
  const forceTimer = setTimeout(() => {
    process.exit(1);
  }, SHIM_STOP_GRACE_MS);
  child.once('close', () => {
    clearTimeout(forceTimer);
    ownedRemoteChild = null;
    process.exit(0);
  });
}

process.once('SIGINT', shutdownShimOwnedChild);
process.once('SIGTERM', shutdownShimOwnedChild);

/**
 * @param {object} options
 * @param {string} options.dist Absolute path to babel-cli dist/index.js
 * @param {string[]} options.argv Full process argv (including node flags)
 * @param {string} options.hostRunReceipt Path to append remote subcommand name
 * @param {string} [options.legacyRunReceipt] Optional legacy-run trap file
 * @param {boolean} [options.includeDesktopCapabilities]
 */
export function runDesktopCliShim(options) {
  const { dist, argv, hostRunReceipt, legacyRunReceipt, includeDesktopCapabilities = false } = options;
  if (includeDesktopCapabilities && argv[0] === '--desktop-capabilities') {
    console.log(JSON.stringify({ schemaVersion: 1, credentialEnvironment: 'native-resolved-v1' }));
    process.exit(0);
  }

  let argvToRun = [...argv];
  const remoteIdx = argvToRun.indexOf('remote');
  let remoteSub = remoteIdx >= 0 ? argvToRun[remoteIdx + 1] : '';
  if (remoteIdx >= 0 && remoteSub === 'serve') {
    argvToRun[remoteIdx + 1] = 'acceptance-bridge';
    remoteSub = 'acceptance-bridge';
  }

  if (remoteIdx >= 0 && (remoteSub === 'serve' || remoteSub === 'acceptance-bridge' || remoteSub === 'host-run')) {
    appendFileSync(hostRunReceipt, `${remoteSub}\n`);
    const childEnv = { ...process.env };
    if (remoteSub === 'acceptance-bridge') childEnv.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE = '1';
    const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argvToRun], {
      cwd: process.cwd(),
      stdio: remoteSub === 'host-run' ? ['pipe', 'pipe', 'inherit'] : 'inherit',
      env: childEnv,
      // Stay in the shim process group so RemoteBridgeChild tree-kill reaches acceptance-bridge.
      detached: false,
    });
    ownedRemoteChild = child;
    if (remoteSub === 'host-run' && child.stdout) {
      child.stdout.on('data', (chunk) => process.stdout.write(chunk));
      if (child.stdin) process.stdin.pipe(child.stdin);
    }
    child.on('exit', (code, signal) => {
      ownedRemoteChild = null;
      process.exit(code ?? (signal ? 1 : 0));
    });
    return;
  }

  if (legacyRunReceipt && argv.includes('run')) {
    writeFileSync(legacyRunReceipt, 'legacy-run');
    process.stdout.write(`${JSON.stringify({ type: 'run_start' })}\n`);
    process.stdout.write(
      `${JSON.stringify({ type: 'run_complete', result: { session_id: 'legacy', answer: 'legacy' } })}\n`,
    );
    process.exit(0);
  }

  console.error('unexpected shim argv', argv);
  process.exit(2);
}
