/**
 * Launcher contract + test-owned startup diagnostics for shared-protocol bridge spawn.
 * Production still withholds raw stderr (REMOTE_STDERR_*); tests only record codes and
 * sanitized spawn metadata when BABEL_TEST_SHARED_PROTOCOL_STARTUP_ARTIFACT=1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, writeFile as writeFileAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { RemoteBridgeChild, buildRemoteServeArgs } from '../native/remoteHost.mjs';
import { productionNodeCliArgv } from '../native/cli-launch.mjs';
import {
  documentedNodeChildSpawnOptions,
  nodeChildSpawnEnvironment,
} from '../native/spawn-env-floor.mjs';

const babelCliDist = resolve(
  fileURLToPath(new URL('../../babel-cli/dist/index.js', import.meta.url)),
);
const desktopCliShimRuntime = fileURLToPath(
  new URL('./desktop-cli-shim-runtime.mjs', import.meta.url),
);

const TOKEN = 'launcher-test-token';

function redactArgv(argv) {
  return argv.map((part) => {
    if (typeof part !== 'string') return part;
    if (part.includes('PROOF') || part.includes('proof')) return '<redacted-proof>';
    return part;
  });
}

async function writeStackShimFixture(root) {
  const project = join(root, 'project');
  const config = join(root, 'config');
  const runsDir = join(root, 'runs');
  const entry = join(root, 'shim.mjs');
  const receipt = join(root, 'receipt.jsonl');
  await mkdir(project);
  await mkdir(config, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(project, 'README.md'), '# launcher');
  await writeFile(join(config, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
  await writeFile(
    entry,
    `import { runDesktopCliShim } from ${JSON.stringify(desktopCliShimRuntime)};
runDesktopCliShim({
  dist: ${JSON.stringify(babelCliDist)},
  argv: process.argv.slice(2),
  hostRunReceipt: ${JSON.stringify(receipt)},
});
`,
  );
  return { project, config, runsDir, entry };
}

test('RemoteBridgeChild uses non-shell spawn with platform detached policy', () => {
  const contract = documentedNodeChildSpawnOptions();
  assert.equal(contract.shell, false);
  assert.equal(contract.windowsHide, true);
  assert.equal(contract.detached, process.platform !== 'win32');
});

test('buildRemoteServeArgs matches productionNodeCliArgv shim entry shape', () => {
  const entry = join(tmpdir(), 'shim.mjs');
  const project = join(tmpdir(), 'project');
  const serveArgs = buildRemoteServeArgs(entry, project, { port: 4701, sharedSession: true });
  const argv = productionNodeCliArgv(entry, serveArgs.slice(1));
  assert.deepEqual(argv.slice(0, 2), ['--experimental-wasm-modules', entry]);
  assert.equal(argv[2], 'remote');
  assert.equal(argv[3], 'serve');
});

test('shared bridge startup with spawn env floor reaches ready', {
  skip: !existsSync(babelCliDist) ? 'missing babel-cli dist' : false,
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-bridge-launcher-'));
  const { project, config, runsDir, entry } = await writeStackShimFixture(root);
  const diagnostics = [];
  const spawnLog = [];
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry,
    projectRoot: project,
    env: nodeChildSpawnEnvironment({
      BABEL_CONFIG_DIR: config,
      BABEL_RUNS_DIR: runsDir,
      ELECTRON_RUN_AS_NODE: '1',
    }),
    inheritEnv: false,
    spawnChild: (executable, argv, options) => {
      spawnLog.push({
        executable,
        argv: redactArgv(argv),
        shell: options.shell,
        windowsHide: options.windowsHide,
        detached: options.detached,
        cwd: options.cwd,
      });
      return spawn(executable, argv, options);
    },
  });
  try {
    const port = 4720 + Math.floor(Math.random() * 80);
    await bridge.start({
      port,
      sharedSession: true,
      readyTimeoutMs: 20_000,
      onLine: (line) => diagnostics.push(line),
    });
    assert.equal(bridge.state, 'ready');
    assert.equal(spawnLog.length, 1);
    assert.equal(spawnLog[0].shell, false);
    assert.equal(spawnLog[0].windowsHide, true);
    assert.equal(spawnLog[0].detached, process.platform !== 'win32');
    assert.equal(
      JSON.stringify(diagnostics).includes(TOKEN),
      false,
      'diagnostic IPC must not echo auth token',
    );
  } finally {
    bridge.stop();
  }
});

test('startup failure records sanitized artifact without raw stderr payloads', {
  skip: !existsSync(babelCliDist) ? 'missing babel-cli dist' : false,
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-bridge-startup-fail-'));
  const entry = join(root, 'exit1.mjs');
  await writeFile(
    entry,
    `process.stderr.write('synthetic-secret-should-not-appear\\n');
process.exit(1);
`,
  );
  const artifactPath = join(root, 'startup-artifact.json');
  const diagnostics = [];
  let stderrBytes = 0;
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry,
    projectRoot: root,
    env: nodeChildSpawnEnvironment(),
    inheritEnv: false,
    spawnChild: (executable, argv, options) => {
      const child = spawn(executable, argv, options);
      child.stderr?.on('data', (chunk) => {
        stderrBytes += chunk.length;
      });
      return child;
    },
  });
  try {
    await assert.rejects(
      bridge.start({
        port: 4733,
        readyTimeoutMs: 2_000,
        onLine: (line) => diagnostics.push(line),
      }),
      /exited before ready/,
    );
    assert.equal(diagnostics.some((line) => line.code === 'REMOTE_STDERR_AVAILABLE'), true);
    assert.equal(
      JSON.stringify(diagnostics).includes('synthetic-secret'),
      false,
      'raw stderr must not be forwarded',
    );
    const artifact = {
      platform: process.platform,
      spawn: documentedNodeChildSpawnOptions(),
      stderrBytesObservedInTestHarness: stderrBytes,
      diagnosticCodes: diagnostics.map((line) => line.code).filter(Boolean),
      argvShape: redactArgv(productionNodeCliArgv(entry, ['remote', 'serve', '--port', '4733'])),
    };
    await writeFileAsync(artifactPath, `${JSON.stringify(artifact)}\n`, 'utf8');
    const text = await import('node:fs/promises').then((m) => m.readFile(artifactPath, 'utf8'));
    assert.equal(text.includes('synthetic-secret'), false);
    assert.ok(stderrBytes > 0, 'harness observed stderr without forwarding payload');
  } finally {
    bridge.stop();
  }
});
