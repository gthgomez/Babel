/**
 * Drives the shipped action→capability mapping, target binding, and
 * lease expiry through decideWithLease / executeActionWithPolicy.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import { evaluateLeaseTemporalValidity } from './leaseTime.js';
import { actionRequestFromAction } from './actionRequest.js';
import { decideWithLease, resetLeaseInvalidations } from './wire.js';
import { decideActionRequest } from './pdp.js';
import { parseGitCommand } from './gitCommand.js';
import { buildBaseline } from './integrity.js';
import { establishAuthoritySession, restoreAuthoritySession } from './sessionContext.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import { governedStrReplace } from '../agent/governedMutations.js';
import type { ToolContext } from '../localTools.js';

function leaseWith(overrides: Record<string, unknown> = {}): AutonomyLease {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'map-lease',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: [
        'inspect_repository',
        'search_repository',
        'edit_task_files',
        'run_tests',
        'run_build',
        'run_lint',
        'run_typecheck',
        'run_local_command',
      ],
      ...overrides,
    }),
  );
  assert.ok(parsed.ok);
  return parsed.lease;
}

function dropCap(lease: AutonomyLease, cap: AutonomyLease['allowedCapabilities'][number]): AutonomyLease {
  return { ...lease, allowedCapabilities: lease.allowedCapabilities.filter((c) => c !== cap) };
}

function ctxFor(lease: AutonomyLease): { lease: AutonomyLease; baseline: { repoRoot: string; manifest: ReturnType<typeof buildBaseline> } } {
  const root = mkdtempSync(join(tmpdir(), 'babel-map-'));
  roots.push(root);
  return { lease, baseline: { repoRoot: root, manifest: buildBaseline(root) } };
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  resetLeaseInvalidations();
});

function dryExecutor() {
  return createToolExecutor({
    executeTool: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
  });
}

function toolCtx(root: string): ToolContext {
  return { agentId: 'map', runId: `map-${Date.now()}`, babelRoot: root };
}

describe('canonical actionRequestFromAction', () => {
  test('read/list/git/workspace_map → inspect_repository', () => {
    assert.equal(actionRequestFromAction({ type: 'read_file', path: 'a.ts' })?.capability, 'inspect_repository');
    assert.equal(actionRequestFromAction({ type: 'list_dir', path: '.' })?.capability, 'inspect_repository');
    assert.equal(actionRequestFromAction({ type: 'git_context' })?.capability, 'inspect_repository');
    assert.equal(actionRequestFromAction({ type: 'workspace_map' })?.capability, 'inspect_repository');
  });

  test('search/grep/glob → search_repository', () => {
    assert.equal(actionRequestFromAction({ type: 'search', query: 'x' })?.capability, 'search_repository');
    assert.equal(actionRequestFromAction({ type: 'grep', pattern: 'x' })?.capability, 'search_repository');
    assert.equal(actionRequestFromAction({ type: 'glob', pattern: '*.ts' })?.capability, 'search_repository');
  });

  test('write_file/apply_patch → edit_task_files', () => {
    assert.equal(
      actionRequestFromAction({ type: 'write_file', path: 'src/foo.ts', content: 'x' })?.capability,
      'edit_task_files',
    );
    assert.equal(actionRequestFromAction({ type: 'apply_patch', patch: 'diff' })?.capability, 'edit_task_files');
  });

  test('test_run → run_tests; control actions unmapped', () => {
    assert.equal(actionRequestFromAction({ type: 'test_run', command: 'npm test' })?.capability, 'run_tests');
    assert.equal(actionRequestFromAction({ type: 'finish', summary: 'done', verification: [] }), null);
    assert.equal(
      actionRequestFromAction({
        type: 'ask_approval',
        reason: 'x',
        requested_action: { type: 'write_file', path: 'a.ts', content: 'x' },
      }),
      null,
    );
  });
});

describe('lease missing capability → DENY on shipped decideWithLease', () => {
  test('missing inspect_repository + read_file → DENY', () => {
    const ctx = ctxFor(dropCap(leaseWith(), 'inspect_repository'));
    const r = decideWithLease({ type: 'read_file', path: 'a.ts' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
  });

  test('missing search_repository + grep/search → DENY', () => {
    const ctx = ctxFor(dropCap(leaseWith(), 'search_repository'));
    assert.equal(decideWithLease({ type: 'grep', pattern: 'x' }, 'workspace_write', ctx).decision, 'deny');
    assert.equal(decideWithLease({ type: 'search', query: 'x' }, 'workspace_write', ctx).decision, 'deny');
  });

  test('missing edit_task_files + write_file/apply_patch → DENY', () => {
    const ctx = ctxFor(dropCap(leaseWith(), 'edit_task_files'));
    assert.equal(
      decideWithLease({ type: 'write_file', path: 'src/foo.ts', content: 'x' }, 'workspace_write', ctx).decision,
      'deny',
    );
    assert.equal(
      decideWithLease({ type: 'apply_patch', patch: 'diff --git a/a b/a\n' }, 'workspace_write', ctx).decision,
      'deny',
    );
  });

  test('missing run_tests + test_run → DENY', () => {
    const ctx = ctxFor(dropCap(leaseWith(), 'run_tests'));
    const r = decideWithLease({ type: 'test_run', command: 'npm test' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
  });

  test('granted capability + valid constraints → proceeds', () => {
    const ctx = ctxFor(leaseWith());
    assert.equal(
      decideWithLease({ type: 'write_file', path: 'src/foo.ts', content: 'x' }, 'workspace_write', ctx).decision,
      'allow',
    );
    assert.equal(decideWithLease({ type: 'read_file', path: 'a.ts' }, 'workspace_write', ctx).decision, 'allow');
    assert.equal(decideWithLease({ type: 'test_run', command: 'npm test' }, 'workspace_write', ctx).decision, 'allow');
  });

  test('missing edit_task_files + governed str_replace → DENY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-str-'));
    roots.push(root);
    writeFileSync(join(root, 'notes.txt'), 'hello world\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: dropCap(leaseWith(), 'edit_task_files'),
    });
    const replace = await governedStrReplace(
      { file_path: 'notes.txt', old_str: 'hello', new_str: 'hi' },
      { projectRoot: root, context: toolCtx(root), authoritySession: session, executor: dryExecutor() },
    );
    assert.equal(replace.policyBlocked, true);
  });
});

describe('exact target binding', () => {
  test('gh pr merge preserves PR identity', () => {
    const p = parseGitCommand('gh pr merge 88');
    assert.equal(p.capability, 'merge');
    assert.equal(p.target, '88');
  });

  test('merge + PR #88 allowed + gh pr merge 88 → VERIFY/ALLOW', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'merge'],
      constraints: {
        ...leaseWith().constraints,
        allowedPullRequests: [88],
      },
    });
    const ctx = ctxFor(lease);
    const r = decideWithLease({ type: 'run_command', command: 'gh pr merge 88' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'allow');
    assert.equal(r.reasonCode, 'VERIFY_BEFORE_PUBLICATION');
  });

  test('merge + PR #88 allowed + gh pr merge 90 → DENY', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'merge'],
      constraints: { ...leaseWith().constraints, allowedPullRequests: [88] },
    });
    const ctx = ctxFor(lease);
    const r = decideWithLease({ type: 'run_command', command: 'gh pr merge 90' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_CAPABILITY_CONSTRAINT');
  });

  test('force_push + feat/x allowed + aliases match; feat/y denies', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'force_push'],
      constraints: {
        ...leaseWith().constraints,
        forcePush: true,
        allowedForcePushBranches: ['feat/x'],
      },
    });
    const ctx = ctxFor(lease);
    const allow = decideWithLease(
      { type: 'run_command', command: 'git push --force origin feat/x' },
      'workspace_write',
      ctx,
    );
    assert.equal(allow.decision, 'allow');
    const alias = decideWithLease(
      { type: 'run_command', command: 'git push --force origin HEAD:refs/heads/feat/x' },
      'workspace_write',
      ctx,
    );
    assert.equal(alias.decision, 'allow');
    const deny = decideWithLease(
      { type: 'run_command', command: 'git push --force origin feat/y' },
      'workspace_write',
      ctx,
    );
    assert.equal(deny.decision, 'deny');
    assert.equal(deny.reasonCode, 'DENY_CAPABILITY_CONSTRAINT');
  });

  test('node -e / python -c wrapping gh merge or force-push is not run_local_command', () => {
    const mergeWrap = parseGitCommand(`node -e "require('child_process').execSync('gh pr merge 90')"`);
    assert.equal(mergeWrap.capability, 'merge');
    assert.equal(mergeWrap.target, '90');
    const forceWrap = parseGitCommand(`python -c "import os; os.system('git push --force origin main')"`);
    assert.equal(forceWrap.capability, 'force_push');
    const lease = leaseWith();
    const ctx = ctxFor(lease);
    const r = decideWithLease(
      {
        type: 'run_command',
        command: `node -e "require('child_process').execSync('gh pr merge 90')"`,
      },
      'workspace_write',
      ctx,
    );
    assert.equal(r.decision, 'deny');
    const noLease = decideWithLease(
      {
        type: 'run_command',
        command: `python -c "import os; os.system('git push --force origin main')"`,
      },
      'workspace_write',
      { lease: null },
    );
    assert.equal(noLease.decision, 'deny');
  });

  test('test_run does not remap interpreter merge carrier to run_tests', () => {
    const req = actionRequestFromAction({
      type: 'test_run',
      command: `node -e "require('child_process').execSync('gh pr merge 90')"`,
    });
    assert.equal(req?.capability, 'merge');
  });

  test('production_deploy + production allowed + staging denies', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'production_deploy'],
      constraints: {
        ...leaseWith().constraints,
        productionDeploy: true,
        allowedEnvironments: ['production'],
      },
    });
    const decoded = parseGitCommand('vercel deploy --prod');
    assert.equal(decoded.capability, 'production_deploy');
    assert.equal(decoded.environment, 'production');
    const ok = decideActionRequest(
      { capability: 'production_deploy', environment: 'production' },
      lease,
    );
    assert.equal(ok.outcome, 'verify');
    const bad = decideActionRequest(
      { capability: 'production_deploy', environment: 'staging' },
      lease,
    );
    assert.equal(bad.outcome, 'deny');
    const stagingCmd = decideWithLease(
      { type: 'run_command', command: 'vercel deploy --staging' },
      'workspace_write',
      ctxFor(lease),
    );
    assert.equal(stagingCmd.decision, 'deny');
    const prodReq = actionRequestFromAction({ type: 'run_command', command: 'vercel deploy --prod' });
    assert.ok(prodReq);
    assert.equal(decideActionRequest(prodReq, lease).outcome, 'verify');
  });
});

describe('lease expiry', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z');

  test('no expiry / future expiry proceed; now and past deny; malformed fail-closed', () => {
    assert.equal(evaluateLeaseTemporalValidity(leaseWith(), now).ok, true);
    const future = leaseWith({ expiresAt: '2026-08-17T13:00:00.000Z' });
    assert.equal(evaluateLeaseTemporalValidity(future, now).ok, true);
    const exact = leaseWith({ expiresAt: '2026-08-17T12:00:00.000Z' });
    assert.equal(evaluateLeaseTemporalValidity(exact, now).ok, false);
    const past = leaseWith({ expiresAt: '2026-08-17T11:00:00.000Z' });
    const pastR = evaluateLeaseTemporalValidity(past, now);
    assert.equal(pastR.ok, false);
    if (!pastR.ok) assert.equal(pastR.reasonCode, 'DENY_LEASE_EXPIRED');
    const bad = leaseWith({ expiresAt: 'not-a-timestamp' });
    const badR = evaluateLeaseTemporalValidity(bad, now);
    assert.equal(badR.ok, false);
    if (!badR.ok) assert.equal(badR.reasonCode, 'DENY_LEASE_INVALID_TIME');
  });

  test('decideWithLease denies expired and malformed leases', () => {
    const expired = leaseWith({ expiresAt: '2020-01-01T00:00:00.000Z' });
    const r = decideWithLease({ type: 'read_file', path: 'a.ts' }, 'workspace_write', {
      ...ctxFor(expired),
      now,
    });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_LEASE_EXPIRED');
    const malformed = leaseWith({ expiresAt: 'yesterday' });
    const m = decideWithLease({ type: 'write_file', path: 'a.ts', content: 'x' }, 'workspace_write', {
      ...ctxFor(malformed),
      now,
    });
    assert.equal(m.reasonCode, 'DENY_LEASE_INVALID_TIME');
  });

  test('resume with expired lease denies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-exp-'));
    roots.push(root);
    writeFileSync(join(root, 'notes.txt'), 'ok\n');
    const persistPath = join(root, 'authority-session.json');
    const expired = leaseWith({ expiresAt: '2020-01-01T00:00:00.000Z' });
    establishAuthoritySession({ repoRoot: root, lease: expired, persistPath });
    const restored = restoreAuthoritySession({ repoRoot: root, persistPath, lease: expired });
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'nope\n' },
      'workspace_write',
      toolCtx(root),
      {
        authoritySession: restored,
        executor: dryExecutor(),
        now: Date.parse('2026-08-17T12:00:00.000Z'),
      },
    );
    assert.equal(result.policyBlocked, true);
    assert.equal(result.reasonCode, 'DENY_LEASE_EXPIRED');
  });
});

describe('mapping does not weaken existing denies', () => {
  test('credential / Class D still denied', () => {
    const ctx = ctxFor(leaseWith());
    const r = decideWithLease({ type: 'run_command', command: 'cat .env' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_CREDENTIAL_READ');
  });

  test('governance self-mutation still denied', () => {
    const ctx = ctxFor(leaseWith());
    const r = decideWithLease(
      { type: 'write_file', path: 'babel-cli/src/authority/pdp.ts', content: 'x' },
      'workspace_write',
      ctx,
    );
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  });
});
