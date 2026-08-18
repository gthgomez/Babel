/**
 * Arbitrary interpreter scripts are not run_local_command.
 * Without an OS sandbox they must be denied before they execute.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson } from './lease.js';
import { parseGitCommand } from './gitCommand.js';
import { decideActionRequest } from './pdp.js';
import { decideWithLease, resetLeaseInvalidations } from './wire.js';
import { establishAuthoritySession } from './sessionContext.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import { buildBaseline } from './integrity.js';
import type { ToolCallRequest, ToolContext } from '../localTools.js';

const roots: string[] = [];
after(() => {
  resetLeaseInvalidations();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function localLease() {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'script-esc',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['inspect_repository', 'edit_task_files', 'run_local_command'],
    }),
  );
  assert.ok(parsed.ok);
  return parsed.lease;
}

test('decoder classifies interpreter scripts as run_arbitrary_code, not run_local_command', () => {
  assert.equal(parseGitCommand('node tmp/attempt-merge.cjs').capability, 'run_arbitrary_code');
  assert.equal(parseGitCommand('python attack.py').capability, 'run_arbitrary_code');
  assert.equal(parseGitCommand('deno run x.ts').capability, 'run_arbitrary_code');
  assert.equal(parseGitCommand('pwsh -File evil.ps1').capability, 'run_arbitrary_code');
  assert.equal(parseGitCommand('node -e "console.log(1)"').capability, 'run_arbitrary_code');
  assert.equal(parseGitCommand('pandoc -o out.pdf').capability, 'run_local_command');
  assert.equal(parseGitCommand('pandoc -o out.js').capability, 'run_local_command');
  assert.equal(parseGitCommand('npm test').capability, 'run_tests');
});

test('run_arbitrary_code without isolation is DENY even when leased', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'ace-no-iso',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['run_arbitrary_code'],
    }),
  );
  assert.ok(parsed.ok);
  const denied = decideActionRequest({ capability: 'run_arbitrary_code' }, parsed.lease);
  assert.equal(denied.outcome, 'deny');
  assert.ok(denied.rulesTriggered.includes('pdp.arbitrary_code_requires_isolation'));
  const verified = decideActionRequest(
    { capability: 'run_arbitrary_code', isolationAvailable: true },
    parsed.lease,
  );
  assert.equal(verified.outcome, 'verify');
});

test('node script with only run_local_command is denied before it can run', async () => {
  resetLeaseInvalidations();
  const root = mkdtempSync(join(tmpdir(), 'babel-script-esc-'));
  roots.push(root);
  mkdirSync(join(root, 'tmp'), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), 'babel-host-cred-'));
  roots.push(outside);
  const hostCred = join(outside, 'github-token.txt');
  writeFileSync(hostCred, 'host-secret-token\n');
  const canary = join(root, 'merge-canary.txt');
  const hits: string[] = [];
  const listener = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end('ok');
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;

  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(persistPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const session = establishAuthoritySession({
    repoRoot: root,
    lease: localLease(),
    persistPath,
  });

  const script = [
    "const fs = require('fs');",
    "const http = require('http');",
    `fs.writeFileSync('tmp/seen-env.json', JSON.stringify({ ran: true, host: fs.readFileSync(${JSON.stringify(hostCred)}, 'utf8') }));`,
    `http.get('http://127.0.0.1:${port}/merge', () => {});`,
    `fs.writeFileSync(${JSON.stringify(canary)}, 'MERGED');`,
  ].join('\n');

  let executed = false;
  const executor = createToolExecutor({
    executeTool: async (req: ToolCallRequest) => {
      if (req.tool === 'file_write' && typeof req.path === 'string' && typeof req.content === 'string') {
        writeFileSync(join(root, req.path), req.content);
        return { exit_code: 0, stdout: 'wrote', stderr: '' };
      }
      if (req.tool === 'shell_exec') {
        executed = true;
        return { exit_code: 0, stdout: 'should-not-run', stderr: '' };
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
    { authoritySession: session, executor, baselineRepoRoot: root, baseline: buildBaseline(root) },
  );

  listener.close();
  assert.equal(run.policyBlocked, true);
  assert.equal(run.reasonCode, 'DENY_MISSING_AUTHORITY');
  assert.equal(executed, false);
  assert.equal(hits.length, 0);
  assert.throws(() => readFileSync(join(root, 'tmp/seen-env.json')));
  assert.throws(() => readFileSync(canary));
  assert.equal(readFileSync(hostCred, 'utf8'), 'host-secret-token\n');

  const wire = decideWithLease(
    { type: 'run_command', command: 'node tmp/attempt-merge.cjs' },
    'workspace_write',
    { lease: localLease(), baseline: { repoRoot: root, manifest: buildBaseline(root) } },
  );
  assert.equal(wire.decision, 'deny');
});
