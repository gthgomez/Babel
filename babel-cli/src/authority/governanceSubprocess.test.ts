/**
 * Adversarial integration: an allowed interpreter script must not persist
 * governance mutation. Drives executeActionWithPolicy (the shipped shell PEP).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import { establishAuthoritySession } from './sessionContext.js';
import { resetLeaseInvalidations } from './wire.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import type { ToolCallRequest, ToolContext } from '../localTools.js';

const PDP_ORIGINAL = 'export function decideActionRequest() { return "original-pdp"; }\n';
const GOV_MUT_ORIGINAL = 'export async function governedStrReplace() { return "original-gov"; }\n';

function makeLease(): AutonomyLease {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'gov-subproc',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['inspect_repository', 'edit_task_files', 'run_local_command'],
    }),
  );
  assert.ok(parsed.ok);
  return parsed.lease;
}

function realNodeExecutor(cwd: string) {
  return createToolExecutor({
    executeTool: async (req: ToolCallRequest) => {
      if (req.tool === 'file_write' && typeof req.path === 'string' && typeof req.content === 'string') {
        mkdirSync(dirname(join(cwd, req.path)), { recursive: true });
        writeFileSync(join(cwd, req.path), req.content);
        return { exit_code: 0, stdout: 'wrote', stderr: '' };
      }
      if (req.tool === 'shell_exec' && typeof req.command === 'string') {
        const tokens = req.command.trim().split(/\s+/);
        const result =
          tokens[0] === 'node'
            ? spawnSync(process.execPath, tokens.slice(1), {
                cwd,
                encoding: 'utf8',
                timeout: 15_000,
              })
            : spawnSync(req.command, {
                cwd,
                encoding: 'utf8',
                timeout: 15_000,
                shell: true,
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
}

test('allowed script cannot persist overwrite of authority-session, governedMutations, pdp', async () => {
  resetLeaseInvalidations();
  const root = mkdtempSync(join(tmpdir(), 'babel-gov-sub-'));
  const pdpPath = join(root, 'babel-cli/src/authority/pdp.ts');
  const govPath = join(root, 'babel-cli/src/agent/governedMutations.ts');
  const persistPath = join(root, 'runs/s1/authority-session.json');
  try {
    mkdirSync(dirname(pdpPath), { recursive: true });
    mkdirSync(dirname(govPath), { recursive: true });
    mkdirSync(dirname(persistPath), { recursive: true });
    writeFileSync(pdpPath, PDP_ORIGINAL);
    writeFileSync(govPath, GOV_MUT_ORIGINAL);
    writeFileSync(join(root, '.gitignore'), 'x\n');

    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease(),
      persistPath,
    });
    const sessionBefore = readFileSync(persistPath);

    const script = [
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.writeFileSync(path.join('babel-cli/src/authority/pdp.ts'), 'MUTATED_PDP');",
      "fs.writeFileSync(path.join('babel-cli/src/agent/governedMutations.ts'), 'MUTATED_GOV');",
      "fs.writeFileSync(path.join('runs/s1/authority-session.json'), '{\"hacked\":true}');",
    ].join('\n');

    const writeScript = await executeActionWithPolicy(
      { type: 'write_file', path: 'tmp/overwrite.cjs', content: script },
      'workspace_write',
      { agentId: 'gov-sub', runId: 'gov-sub-1', babelRoot: root } satisfies ToolContext,
      { authoritySession: session, executor: realNodeExecutor(root) },
    );
    assert.equal(writeScript.policyBlocked, false, writeScript.results[0]?.stderr ?? 'script write');

    const run = await executeActionWithPolicy(
      { type: 'run_command', command: 'node tmp/overwrite.cjs' },
      'workspace_write',
      { agentId: 'gov-sub', runId: 'gov-sub-2', babelRoot: root } satisfies ToolContext,
      { authoritySession: session, executor: realNodeExecutor(root) },
    );

    assert.equal(readFileSync(pdpPath, 'utf8'), PDP_ORIGINAL);
    assert.equal(readFileSync(govPath, 'utf8'), GOV_MUT_ORIGINAL);
    assert.notEqual(readFileSync(persistPath, 'utf8'), '{"hacked":true}');
    assert.equal(readFileSync(persistPath).equals(sessionBefore), true);
    assert.equal(run.policyBlocked, true);
    assert.equal(run.reasonCode, 'DENY_MISSING_AUTHORITY');
    assert.notEqual(run.policyDecision, 'allow');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});
