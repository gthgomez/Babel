import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseDesktopApprovalLine, parseDesktopDecision } from './desktopApproval.js';

test('desktop approval accepts only an explicit allow_once decision', () => {
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_once"}'), 'allow_once');
  assert.equal(parseDesktopApprovalLine('{"decision":"deny"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_session"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('not-json'), 'deny');
  assert.equal(parseDesktopDecision('{"decision":"cancel"}'), 'cancel');
  assert.equal(parseDesktopApprovalLine('{"decision":"cancel"}'), 'deny');
});

test('a completed Desktop turn exits with the parent stdin pipe still open', async () => {
  const moduleUrl = new URL('./desktopApproval.ts', import.meta.url).href;
  const script = `const ipc = await import(${JSON.stringify(moduleUrl)}); ipc.startDesktopIpc(); ipc.stopDesktopIpc?.(); if (ipc.stopDesktopIpc) { const approval = ipc.waitForDesktopApproval({command:'synthetic fixture',reason:'test'}); ipc.stopDesktopIpc(); if (await approval) throw Error('Closed channel approved'); ipc.startDesktopIpc(); ipc.stopDesktopIpc(); } console.log('turn finished');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, BABEL_DESKTOP_IPC: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('turn finished') && !exitTimer) {
      clearTimeout(startupTimer);
      exitTimer = setTimeout(() => child.kill(), 2000);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const startupTimer = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, `Completed turn stayed alive or failed: ${stderr}`);
    assert.match(stdout, /turn finished/);
  } finally { clearTimeout(startupTimer); clearTimeout(exitTimer); child.kill(); }
});
