import assert from 'node:assert/strict';
import test from 'node:test';
import { executeAwaitCommandAction, executeBackgroundRunCommandAction, type BackgroundShellActionCtx } from './chatBackgroundShell.js';
import { classifyBlockingOrigin } from './chatEngineSupport.js';

test('background chat dispatch requires the same explicit host fallback for project code', () => {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
  const logs: Array<{ detail?: string; error?: string }> = [];
  const context: BackgroundShellActionCtx = {
    projectRoot: process.cwd(),
    tool: 'run_command',
    target: 'node --version',
    toolId: 1,
    index: 0,
    pushLog: (entry) => logs.push(entry),
  };
  try {
    const result = executeBackgroundRunCommandAction({ command: 'node --version' }, context);
    assert.match(result.observation, /isolation_required/);
    assert.equal(logs.at(-1)?.detail, 'isolation_required');
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
  }
});

test('settled nonzero background exit retains authoritative failure evidence', async () => {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  const logs: Array<{ tool: string; target: string; working_directory?: string; processExecuted?: boolean; processCompleted?: boolean; processExecutionId?: string; exit_code?: number; stderr?: string; error?: string }> = [];
  const context: BackgroundShellActionCtx = {
    projectRoot: process.cwd(), tool: 'run_command', target: 'node failure fixture', toolId: 1, index: 0,
    pushLog: entry => logs.push(entry),
  };
  try {
    const started = executeBackgroundRunCommandAction({
      command: 'cat /proc/1/mem',
    }, context);
    const taskId = /task_id="([^"]+)"/.exec(started.observation)?.[1];
    assert.ok(taskId, started.observation);
    const settled = await executeAwaitCommandAction({ task_id: taskId!, timeout_seconds: 5 }, {
      ...context, tool: 'await_command', target: taskId!, toolId: 2, index: 1,
    });
    assert.match(settled.observation, /status: failed/);
    const entry = logs.at(-1)!;
    assert.equal(entry.exit_code, 1);
    assert.equal(entry.processCompleted, true, 'nonzero exit still has a settled child lifecycle');
    assert.equal(classifyBlockingOrigin(entry), 'permission_denied', 'settled stderr remains eligible blocker evidence');
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
  }
});

test('background command logs bind cwd and only mark a completed process after await', async () => {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  const logs: Array<{ tool: string; target: string; working_directory?: string; processExecuted?: boolean; processCompleted?: boolean; processExecutionId?: string; exit_code?: number }> = [];
  const projectRoot = process.cwd();
  const context: BackgroundShellActionCtx = {
    projectRoot,
    tool: 'run_command',
    target: 'node --version',
    toolId: 1,
    index: 0,
    pushLog: entry => logs.push(entry),
  };
  try {
    const started = executeBackgroundRunCommandAction({ command: 'node --version' }, context);
    assert.match(started.observation, /task_id="[^"]+"/);
    const taskId = /task_id="([^"]+)"/.exec(started.observation)?.[1];
    assert.ok(taskId);
    const startLog = logs.at(-1);
    assert.equal(startLog?.working_directory, projectRoot);
    assert.equal(startLog?.processCompleted, false, 'spawn/start is not process completion');

    const awaited = await executeAwaitCommandAction({ task_id: taskId!, timeout_seconds: 5 }, {
      ...context,
      tool: 'await_command',
      target: taskId!,
      toolId: 2,
      index: 1,
    });
    assert.match(awaited.observation, /exit_code: 0/);
    const completionLog = logs.at(-1);
    assert.equal(completionLog?.tool, 'await_command');
    assert.equal(completionLog?.target, 'node --version');
    assert.equal(completionLog?.working_directory, projectRoot);
    assert.equal(completionLog?.processExecuted, true);
    assert.equal(completionLog?.processCompleted, true);
    assert.ok(completionLog?.processExecutionId, 'completion receipt retains the original host dispatch identity');
    assert.equal(completionLog?.processExecutionId, startLog?.processExecutionId);
    assert.equal(completionLog?.exit_code, 0);
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
  }
});
