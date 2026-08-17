/**
 * P0-88: governed str_replace must share the lease-aware authority path
 * with write_file. No production decideAction override.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLeaseJson, type AutonomyLease } from '../authority/lease.js';
import { establishAuthoritySession } from '../authority/sessionContext.js';
import { isGovernancePath } from '../authority/integrity.js';
import { decideWithLease, resetLeaseInvalidations } from '../authority/wire.js';
import { executeActionWithPolicy, createToolExecutor } from './toolExecutor.js';
import { governedStrReplace } from './governedMutations.js';
import type { AgentAction } from './actions.js';
import type { ToolContext } from '../localTools.js';

function makeLease(leaseId: string): AutonomyLease {
  return (
    parseLeaseJson(
      JSON.stringify({
        version: 2,
        leaseId,
        scope: { repository: 'babel', remote: 'origin' },
        allowedCapabilities: [
          'inspect_repository',
          'search_repository',
          'edit_task_files',
          'run_tests',
          'run_local_command',
        ],
      }),
    ) as { ok: true; lease: AutonomyLease }
  ).lease;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-gov-auth-'));
}

function ctx(root: string): ToolContext {
  return { agentId: 'gov-auth', runId: `gov-auth-${Date.now()}`, babelRoot: root };
}

function dryExecutor() {
  return createToolExecutor({
    executeTool: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
  });
}

test('leased write_file and str_replace receive the same PDP result', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    writeFileSync(join(root, 'notes.txt'), 'hello world\n');
    writeFileSync(join(root, '.gitignore'), 'x\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('same-pdp'),
    });
    const write = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'hello world\nchanged\n' },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor() },
    );
    const replace = await governedStrReplace(
      { file_path: 'notes.txt', old_str: 'hello world', new_str: 'hello babel' },
      {
        projectRoot: root,
        context: ctx(root),
        authoritySession: session,
        executor: dryExecutor(),
      },
    );
    assert.equal(write.policyBlocked, replace.policyBlocked);
    assert.equal(write.policyDecision, replace.policyDecision ?? write.policyDecision);
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidated authority session blocks str_replace', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    writeFileSync(join(root, 'notes.txt'), 'hello\n');
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('invalidated-str'),
    });
    writeFileSync(join(root, '.gitignore'), 'drifted\n');
    const replace = await governedStrReplace(
      { file_path: 'notes.txt', old_str: 'hello', new_str: 'bye' },
      {
        projectRoot: root,
        context: ctx(root),
        authoritySession: session,
        executor: dryExecutor(),
      },
    );
    assert.equal(replace.policyBlocked, true);
    assert.equal(replace.policyDecision, 'deny');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('governance-target str_replace returns DENY_POLICY_SELF_MUTATION', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    const target = join(root, 'babel-cli/src/agent/governedMutations.ts');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export const x = 1;\n');
    writeFileSync(join(root, '.gitignore'), 'x\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('gov-str'),
    });
    const replace = await governedStrReplace(
      { file_path: 'babel-cli/src/agent/governedMutations.ts', old_str: 'export const x = 1;', new_str: 'export const x = 2;' },
      {
        projectRoot: root,
        context: ctx(root),
        authoritySession: session,
        executor: dryExecutor(),
      },
    );
    assert.equal(replace.policyBlocked, true);
    const writeDecision = decideWithLease(
      { type: 'write_file', path: 'babel-cli/src/agent/governedMutations.ts', content: 'x' },
      'workspace_write',
      {
        lease: session.lease,
        ...(session.baseline ? { baseline: { repoRoot: session.repoRoot, manifest: session.baseline } } : {}),
        authoritySession: session,
      },
    );
    assert.equal(writeDecision.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct write_file to governedMutations.ts is denied as self-mutation', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    const target = join(root, 'babel-cli/src/agent/governedMutations.ts');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export const x = 1;\n');
    writeFileSync(join(root, '.gitignore'), 'x\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('gov-write'),
    });
    const write = await executeActionWithPolicy(
      { type: 'write_file', path: 'babel-cli/src/agent/governedMutations.ts', content: 'pwned' },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor() },
    );
    assert.equal(write.policyBlocked, true);
    assert.equal(write.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch targeting governedMutations.ts is denied', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    const target = join(root, 'babel-cli/src/agent/governedMutations.ts');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export const x = 1;\n');
    writeFileSync(join(root, '.gitignore'), 'x\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('gov-patch'),
    });
    const patch = [
      'diff --git a/babel-cli/src/agent/governedMutations.ts b/babel-cli/src/agent/governedMutations.ts',
      '--- a/babel-cli/src/agent/governedMutations.ts',
      '+++ b/babel-cli/src/agent/governedMutations.ts',
      '@@ -1 +1 @@',
      '-export const x = 1;',
      '+export const x = 2;',
    ].join('\n');
    const decision = decideWithLease(
      { type: 'apply_patch', patch } as AgentAction,
      'workspace_write',
      {
        lease: session.lease,
        ...(session.baseline ? { baseline: { repoRoot: session.repoRoot, manifest: session.baseline } } : {}),
        authoritySession: session,
      },
    );
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.reasonCode, 'DENY_POLICY_SELF_MUTATION');
    const result = await executeActionWithPolicy(
      { type: 'apply_patch', patch } as AgentAction,
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor() },
    );
    assert.equal(result.policyBlocked, true);
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file to authority-session.json is denied', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'x\n');
    mkdirSync(join(root, 'runs', 'chat-sessions', 's1'), { recursive: true });
    writeFileSync(join(root, 'runs', 'chat-sessions', 's1', 'authority-session.json'), '{}');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('auth-state'),
    });
    const write = await executeActionWithPolicy(
      {
        type: 'write_file',
        path: 'runs/chat-sessions/s1/authority-session.json',
        content: '{"invalidated":false}',
      },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor() },
    );
    assert.equal(write.policyBlocked, true);
    assert.equal(write.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('governedMutations.ts is a governance path', () => {
  assert.equal(isGovernancePath('babel-cli/src/agent/governedMutations.ts'), true);
});

test('no production decideAction override remains on governedStrReplace', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'governedMutations.ts'), 'utf8');
  assert.equal(/\bdecide:\s*decideAction\b/.test(source), false);
});
