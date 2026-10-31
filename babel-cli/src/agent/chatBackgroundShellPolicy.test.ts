import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBackgroundRunCommandAction, type BackgroundShellActionCtx } from './chatBackgroundShell.js';

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
