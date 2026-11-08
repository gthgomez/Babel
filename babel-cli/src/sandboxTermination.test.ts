import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import * as sandbox from './sandbox.js'
import { ProcessWitness } from './diagnostics/bdns/processWitness.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProcessAlive, waitForProcessExit } from './processTree.js'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createToolExecutor, ToolExecutionCancelledError } from './agent/toolExecutor.js'

test('container removal waits for the cancelled launch client physical closure', async t => {
  const executor = new sandbox.SafeExecutor(process.cwd())
  const controller = new AbortController()
  const owner = 'container-launch-order'
  let child: ReturnType<typeof childProcess.spawn> | undefined
  let cleanupAfterClose = false
  const spawn = childProcess.spawn
  t.mock.method(executor as unknown as { prepareShellExecution: () => unknown }, 'prepareShellExecution', () => ({
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), env: process.env,
    ownedContainerName: 'babel-run-00000000-0000-0000-0000-000000000000',
  }))
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { child = spawn(...args); return child })
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    cleanupAfterClose = child?.exitCode != null || child?.signalCode != null
    const callback = args.at(-1)
    assert.equal(typeof callback, 'function')
    if (typeof callback === 'function') queueMicrotask(() => callback(null, 'removed', ''))
    return new childProcess.ChildProcess()
  })
  syncBuiltinESMExports()
  try {
    const pending = executor.shellExecAsync('node hold.mjs', '.', 15_000, 'test_run', controller.signal, { sessionId: owner })
    controller.abort()
    assert.notEqual((await pending).exit_code, 0)
    await sandbox.awaitPendingProcessTerminations(owner)
    assert.equal(cleanupAfterClose, true, 'daemon cleanup must follow this launch client physical closure')
  } finally {
    controller.abort()
    await sandbox.awaitPendingProcessTerminations(owner)
    t.mock.restoreAll(); syncBuiltinESMExports()
  }
})

test('owner drain waits for a cancelled executor child when process diagnostics are disabled', async () => {
  // Trusted host-only supervisor fixture; this is not live-provider qualification.
  const root = mkdtempSync(join(tmpdir(), 'babel-owner-drain-'))
  const previous = process.env['BABEL_EXECUTION_PROFILE']
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK']
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  writeFileSync(join(root, 'hold.mjs'), "import fs from 'node:fs';fs.writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);\n")
  const controller = new AbortController()
  try {
    const pending = new sandbox.SafeExecutor(root).shellExecAsync('node hold.mjs', root, 15_000, 'test_run', controller.signal, { sessionId: 'owner-without-diagnostics' })
    let earlyResult: sandbox.ToolResult | undefined
    void pending.then(result => { earlyResult = result })
    const deadline = Date.now() + 5_000
    while (!existsSync(join(root, 'pid.txt'))) {
      if (earlyResult) throw new Error(`Owned fixture ended before its start marker: ${earlyResult.stderr}`)
      if (Date.now() > deadline) throw new Error('Owned fixture process did not start')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const pid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'))
    controller.abort()
    assert.notEqual((await pending).exit_code, 0)
    await sandbox.awaitPendingProcessTerminations('owner-without-diagnostics')
    assert.equal(isProcessAlive(pid), false, 'an owner drain must include its real child even without a ProcessWitness')
  } finally {
    controller.abort()
    await sandbox.awaitPendingProcessTerminations()
    if (previous === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = previous
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK']; else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback
    rmSync(root, { recursive: true, force: true })
  }
})

test('tool executor does not settle cancellation before its real child tree exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-tool-owner-drain-'))
  const previous = process.env['BABEL_EXECUTION_PROFILE']
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK']
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  writeFileSync(join(root, 'hold.mjs'), "import fs from 'node:fs';fs.writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);\n")
  const controller = new AbortController(); const owner = 'tool-owner-real-child'
  try {
    const sandboxExecutor = new sandbox.SafeExecutor(root)
    const executor = createToolExecutor({ executeTool: async (_request, context) => sandboxExecutor.shellExecAsync('node hold.mjs', root, 15_000, 'test_run', context.signal, { sessionId: context.sessionId ?? context.runId }) })
    const pending = executor.execute({ type: 'run_command', command: 'node hold.mjs' }, { agentId: 'fixture', runId: owner, babelRoot: root, projectRoot: root, signal: controller.signal }, { perToolTimeoutMs: 15_000, maxIterations: 1 }).then(() => null, error => error)
    const deadline = Date.now() + 5_000
    while (!existsSync(join(root, 'pid.txt'))) {
      if (Date.now() > deadline) throw new Error('Owned fixture process did not start')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const pid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'))
    controller.abort()
    assert.ok(await pending instanceof ToolExecutionCancelledError)
    assert.equal(isProcessAlive(pid), false, 'the owner must wait for its real child to exit')
  } finally {
    controller.abort()
    await sandbox.awaitPendingProcessTerminations(owner)
    if (previous === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = previous
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK']; else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback
    rmSync(root, { recursive: true, force: true })
  }
})

test('a settled deferred termination failure remains visible until its owner drains it', async () => {
  assert.equal(typeof sandbox.registerPendingProcessTermination, 'function')
  sandbox.registerPendingProcessTermination(Promise.reject(new Error('kill failed')), 'task-A', 'process-A')
  await nextTurn()
  await sandbox.awaitPendingProcessTerminations('task-B')
  await assert.rejects(
    sandbox.awaitPendingProcessTerminations('task-A'),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'PROCESS_TERMINATION_FAILED' &&
      'ownerId' in error && error.ownerId === 'task-A',
  )
  await sandbox.awaitPendingProcessTerminations('task-A')
})

test('a successful deferred termination closes once and does not affect another owner', async () => {
  let finish!: () => void
  const termination = new Promise<void>((resolve) => { finish = resolve })
  sandbox.registerPendingProcessTermination(termination, 'task-success', 'process-success')
  await sandbox.awaitPendingProcessTerminations('task-other')
  finish()
  await sandbox.awaitPendingProcessTerminations('task-success')
  await sandbox.awaitPendingProcessTerminations('task-success')
})

test('cancel settles promptly but process exit witness waits for physical close', async () => {
  const witness = new ProcessWitness()
  let exits = 0
  const recordExit = witness.exited.bind(witness)
  witness.exited = (...args) => { exits++; recordExit(...args) }
  const controller = new AbortController()
  const result = sandbox.spawnCommandAsync(process.execPath, [
    '-e', 'setTimeout(() => {}, 10000)',
  ], {
    cwd: process.cwd(), timeoutMs: 15_000, env: process.env,
    signal: controller.signal, processWitness: witness,
    processContext: { sessionId: 'pr242-cancel-witness' },
  })
  controller.abort()
  assert.equal((await result).aborted, true)
  assert.equal(exits, 0)
  await sandbox.awaitPendingProcessTerminations('pr242-cancel-witness')
  assert.equal(exits, 1)
})

test('cancel records process_exited before process_killed on the witness bus', async () => {
  const witness = new ProcessWitness()
  const events: string[] = []
  const recordExit = witness.exited.bind(witness)
  const recordKilled = witness.killed.bind(witness)
  witness.exited = (...args) => {
    events.push('exited')
    recordExit(...args)
  }
  witness.killed = (...args) => {
    events.push('killed')
    recordKilled(...args)
  }
  const controller = new AbortController()
  const pending = sandbox.spawnCommandAsync(process.execPath, [
    '-e', 'setTimeout(() => {}, 10_000)',
  ], {
    cwd: process.cwd(), timeoutMs: 15_000, env: process.env,
    signal: controller.signal, processWitness: witness,
    processContext: { sessionId: 'pr242-cancel-witness-order' },
  })
  controller.abort()
  assert.equal((await pending).aborted, true)
  assert.deepEqual(events, [], 'witness must not fire before physical close and latch drain')
  await sandbox.awaitPendingProcessTerminations('pr242-cancel-witness-order')
  assert.deepEqual(events, ['exited', 'killed'], 'exited must precede killed')
})

test('a local supervisor deadline does not return while its owned descendant is alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-timeout-descendant-'));
  const childFile = join(root, 'child.mjs');
  const parentFile = join(root, 'parent.mjs');
  writeFileSync(childFile, "import fs from 'node:fs'; fs.writeFileSync('child.pid', String(process.pid)); setTimeout(() => process.exit(0), 8000);\n");
  writeFileSync(parentFile, "import { spawn } from 'node:child_process'; spawn(process.execPath, ['child.mjs'], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 10000);\n");
  try {
    const result = await sandbox.spawnCommandAsync(process.execPath, [parentFile], {
      cwd: root, timeoutMs: 2000, env: process.env,
      processContext: { sessionId: 'synthetic-timeout-descendant' },
    });
    assert.equal(result.timedOut, true);
    assert.equal(existsSync(join(root, 'child.pid')), true, 'owned descendant must have started before the deadline');
    const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    assert.equal(isProcessAlive(pid), false, 'supervisor returned before its descendant exited');
  } finally {
    // The owned synthetic descendant also has a bounded self-exit, even if the assertion fails.
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed Windows tree-kill is not accepted as descendant settlement', { skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-tree-kill-failure-'));
  const owner = 'tree-kill-failure-control';
  const controller = new AbortController();
  let ownedPid: number | undefined;
  writeFileSync(join(root, 'hold.mjs'), "import fs from 'node:fs'; fs.writeFileSync('pid.txt', String(process.pid)); setTimeout(() => process.exit(0), 8000);\n");
  try {
    const pending = sandbox.spawnCommandAsync(process.execPath, [join(root, 'hold.mjs')], {
      cwd: root, timeoutMs: 15000, env: process.env, signal: controller.signal,
      processContext: { sessionId: owner },
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, 'pid.txt'))) {
      if (Date.now() > deadline) throw new Error('Owned fixture process did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ownedPid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'));
    t.mock.method(childProcess, 'spawnSync', (() => ({ status: 1, error: undefined })) as unknown as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    controller.abort();
    await pending;
    await assert.rejects(sandbox.awaitPendingProcessTerminations(owner), /did not terminate cleanly/);
  } finally {
    controller.abort();
    try { await sandbox.awaitPendingProcessTerminations(owner); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    if (ownedPid !== undefined) await waitForProcessExit(ownedPid, 5000);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('failed Windows tree-kill on a deadline leaves a termination failure for the owner', { skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-timeout-tree-failure-'));
  const owner = 'timeout-tree-failure-control';
  let ownedPid: number | undefined;
  writeFileSync(join(root, 'hold.mjs'), "import fs from 'node:fs'; fs.writeFileSync('pid.txt', String(process.pid)); setTimeout(() => process.exit(0), 8000);\n");
  try {
    const pending = sandbox.spawnCommandAsync(process.execPath, [join(root, 'hold.mjs')], {
      cwd: root, timeoutMs: 1500, env: process.env, processContext: { sessionId: owner },
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, 'pid.txt'))) {
      if (Date.now() > deadline) throw new Error('Owned fixture process did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ownedPid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'));
    t.mock.method(childProcess, 'spawnSync', (() => ({ status: 1, error: undefined })) as unknown as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    const result = await pending;
    assert.equal(result.timedOut, true);
    await assert.rejects(sandbox.awaitPendingProcessTerminations(owner), /did not terminate cleanly/);
  } finally {
    try { await sandbox.awaitPendingProcessTerminations(owner); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    if (ownedPid !== undefined) await waitForProcessExit(ownedPid, 5000);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('a timed-out shell reports failed Windows tree termination to its caller', { skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-timeout-shell-failure-'));
  const owner = 'timeout-shell-failure-control';
  let ownedPid: number | undefined;
  writeFileSync(join(root, 'hold.mjs'), "import fs from 'node:fs'; fs.writeFileSync('pid.txt', String(process.pid)); setTimeout(() => process.exit(0), 8000);\n");
  const executor = new sandbox.SafeExecutor(root);
  t.mock.method(executor as unknown as { prepareShellExecution: () => unknown }, 'prepareShellExecution', () => ({
    executable: process.execPath, args: [join(root, 'hold.mjs')], cwd: root, env: process.env,
  }));
  try {
    const pending = executor.shellExecAsync('synthetic', root, 1500, 'test_run', undefined, { sessionId: owner });
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, 'pid.txt'))) {
      if (Date.now() > deadline) throw new Error('Owned fixture process did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ownedPid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'));
    t.mock.method(childProcess, 'spawnSync', (() => ({ status: 1, error: undefined })) as unknown as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    await assert.rejects(pending, /did not terminate cleanly/);
  } finally {
    try { await sandbox.awaitPendingProcessTerminations(owner); } catch { /* the assertion observes the same owned failure */ }
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (ownedPid !== undefined) await waitForProcessExit(ownedPid, 5000);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('failed owned-container cleanup is surfaced as unsettled work', async t => {
  const executor = new sandbox.SafeExecutor(process.cwd());
  const controller = new AbortController();
  const owner = 'container-cleanup-failure-control';
  t.mock.method(executor as unknown as { prepareShellExecution: () => unknown }, 'prepareShellExecution', () => ({
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), env: process.env,
    ownedContainerName: 'babel-run-00000000-0000-0000-0000-000000000000',
  }));
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(new Error('synthetic daemon failure'), '', ''));
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  try {
    const pending = executor.shellExecAsync('synthetic', '.', 15000, 'test_run', controller.signal, { sessionId: owner });
    controller.abort();
    await assert.rejects(pending, /did not terminate cleanly/);
  } finally {
    controller.abort();
    try { await sandbox.awaitPendingProcessTerminations(owner); } catch { /* failure is asserted above */ }
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
