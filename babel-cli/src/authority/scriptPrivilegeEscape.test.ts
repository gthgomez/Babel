/**
 * Arbitrary script files must not inherit GitHub/cloud privilege.
 * The effect boundary is the child env, not regex over script source.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson } from './lease.js';
import { establishAuthoritySession } from './sessionContext.js';
import { resetLeaseInvalidations } from './wire.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import {
  buildUnprivilegedChildEnv,
  isUnprivilegedChildEnvActive,
  runWithUnprivilegedChildEnv,
} from './unprivilegedChildEnv.js';
import type { ToolCallRequest, ToolContext } from '../localTools.js';

const roots: string[] = [];
after(() => {
  resetLeaseInvalidations();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('unprivileged env strips tokens and isolates gh config', () => {
  const env = buildUnprivilegedChildEnv({
    PATH: process.env['PATH'],
    GH_TOKEN: 'ghs_should_not_leak',
    GITHUB_TOKEN: 'gho_should_not_leak',
    AWS_SECRET_ACCESS_KEY: 'aws_should_not_leak',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'],
  });
  assert.equal(env['GH_TOKEN'], undefined);
  assert.equal(env['GITHUB_TOKEN'], undefined);
  assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.ok(env['GH_CONFIG_DIR']);
  assert.notEqual(env['GH_CONFIG_DIR'], process.env['GH_CONFIG_DIR']);
});

test('runWithUnprivilegedChildEnv marks the async context', () => {
  assert.equal(isUnprivilegedChildEnvActive(), false);
  const inside = runWithUnprivilegedChildEnv(() => isUnprivilegedChildEnvActive());
  assert.equal(inside, true);
  assert.equal(isUnprivilegedChildEnvActive(), false);
});

test('node script with only run_local_command cannot perform a privileged GitHub merge', async () => {
  resetLeaseInvalidations();
  const root = mkdtempSync(join(tmpdir(), 'babel-script-esc-'));
  roots.push(root);
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });

  const canary = join(root, 'merge-canary.txt');
  const fakeGh = join(root, process.platform === 'win32' ? 'bin/gh.cmd' : 'bin/gh');
  if (process.platform === 'win32') {
    writeFileSync(
      fakeGh,
      [
        '@echo off',
        `if not defined GH_TOKEN goto nochance`,
        `echo MERGED> "${canary}"`,
        'exit /b 0',
        ':nochance',
        'echo no-token 1>&2',
        'exit /b 1',
      ].join('\r\n'),
    );
  } else {
    writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ -n "$GH_TOKEN" ]; then echo MERGED > "${canary.replace(/\\/g, '/')}"; exit 0; fi\necho no-token >&2; exit 1\n`,
    );
    chmodSync(fakeGh, 0o755);
  }

  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'script-esc',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['inspect_repository', 'edit_task_files', 'run_local_command'],
    }),
  );
  assert.ok(parsed.ok);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirnameSafe(persistPath), { recursive: true });
  const session = establishAuthoritySession({
    repoRoot: root,
    lease: parsed.lease,
    persistPath,
  });

  const script = [
    "const { spawnSync } = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "fs.writeFileSync(path.join('tmp', 'seen-env.json'), JSON.stringify({",
    '  GH_TOKEN: process.env.GH_TOKEN || null,',
    '  GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,',
    '}));',
    "const r = spawnSync('gh', ['pr', 'merge', '90', '--squash'], { stdio: 'inherit', shell: process.platform === 'win32' });",
    'process.exit(r.status === 0 ? 0 : 1);',
  ].join('\n');

  const parentEnv = {
    ...process.env,
    GH_TOKEN: 'ghs_parent_secret',
    GITHUB_TOKEN: 'gho_parent_secret',
    PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`,
  };

  const executor = createToolExecutor({
    executeTool: async (req: ToolCallRequest) => {
      if (req.tool === 'file_write' && typeof req.path === 'string' && typeof req.content === 'string') {
        writeFileSync(join(root, req.path), req.content);
        return { exit_code: 0, stdout: 'wrote', stderr: '' };
      }
      if (req.tool === 'shell_exec' && typeof req.command === 'string') {
        const tokens = req.command.trim().split(/\s+/);
        const childEnv = buildUnprivilegedChildEnv(parentEnv);
        childEnv.PATH = parentEnv.PATH;
        const result =
          tokens[0] === 'node'
            ? spawnSync(process.execPath, tokens.slice(1), {
                cwd: root,
                encoding: 'utf8',
                timeout: 15_000,
                env: childEnv,
              })
            : spawnSync(req.command, {
                cwd: root,
                encoding: 'utf8',
                timeout: 15_000,
                shell: true,
                env: childEnv,
              });
        return {
          exit_code: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? result.error?.message ?? '',
        };
      }
      return { exit_code: 1, stdout: '', stderr: `unexpected tool ${req.tool}` };
    },
  });

  const ctx: ToolContext = { agentId: 'esc', runId: 'esc-1', babelRoot: root };
  const writeScript = await executeActionWithPolicy(
    { type: 'write_file', path: 'tmp/attempt-merge.cjs', content: script },
    'workspace_write',
    ctx,
    { authoritySession: session, executor },
  );
  assert.equal(writeScript.policyBlocked, false, writeScript.results[0]?.stderr ?? 'script write');

  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'node tmp/attempt-merge.cjs' },
    'workspace_write',
    { agentId: 'esc', runId: 'esc-2', babelRoot: root },
    { authoritySession: session, executor },
  );

  const seen = JSON.parse(readFileSync(join(root, 'tmp/seen-env.json'), 'utf8')) as {
    GH_TOKEN: string | null;
    GITHUB_TOKEN: string | null;
  };
  assert.equal(seen.GH_TOKEN, null);
  assert.equal(seen.GITHUB_TOKEN, null);
  assert.equal(existsCanary(canary), false);
  assert.notEqual(run.results[0]?.exit_code, 0);
});

function dirnameSafe(p: string): string {
  return p.replace(/[\\/][^\\/]+$/, '');
}

function existsCanary(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes('MERGED');
  } catch {
    return false;
  }
}
