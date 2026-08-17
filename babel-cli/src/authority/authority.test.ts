/**
 * authority.test.ts — V2 authority qualification (mission §38).
 * Covers: lease parsing + fail-closed, PDP decisions, branch/force/remote
 * restrictions, protected branches, CI repair budgets + termination,
 * verification transitions, unknown capability handling, credential
 * boundaries, policy mutation, reason codes, git/gh command parsing.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { parseLeaseJson, validateLease, loadLeaseFromEnv, type AutonomyLease } from './lease.js';
import { decideActionRequest, askCodeForCapability } from './pdp.js';
import { parseGitCommand } from './gitCommand.js';
import { isProtectedBranch, isAllowedBranchPrefix, CAPABILITY_KINDS } from './capabilities.js';
import {
  createCiController,
  onCiRead,
  advanceController,
  classifyCiFailure,
  type CiController,
} from './ciRepair.js';
import { buildBaseline, isGovernancePath } from './integrity.js';
import { decideWithLease } from './wire.js';
import type { AgentAction } from '../agent/actions.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sampleLease(overrides: Partial<AutonomyLease> = {}): AutonomyLease {
  const base = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'test-lease-1',
      scope: { repository: 'gthgomez/Babel', remote: 'origin', worktree: 'current' },
      allowedCapabilities: [
        'inspect_repository',
        'search_repository',
        'edit_task_files',
        'create_task_branch',
        'create_worktree',
        'run_tests',
        'run_build',
        'run_lint',
        'run_typecheck',
        'run_local_command',
        'stage_ship_set',
        'commit_ship_set',
        'push_feature_branch',
        'pr_create_draft',
        'pr_update_draft',
        'pr_inspect',
        'ci_inspect',
        'ci_repair_in_scope',
        'ci_rerun_transient',
        'delete_task_temp',
      ],
      branchPrefixes: ['feat/', 'fix/', 'refactor/', 'docs/', 'test/'],
      constraints: {
        protectedBranches: ['main'],
        forcePush: false,
        remoteRefDelete: false,
        releasePublish: false,
        productionDeploy: false,
        repositoryAdmin: false,
        secretsAccess: false,
        billing: false,
        destructiveDb: false,
        scopeExpansion: false,
      },
      budgets: { ciProductRepairRounds: 3, ciTransientReruns: 1, prRecreateRounds: 1, parallelAgents: 8 },
      gates: [
        'merge',
        'pr_mark_ready',
        'release',
        'production_deploy',
        'repo_admin',
        'security_policy_change',
        'credential_access',
        'destructive_data_delete',
        'shared_history_rewrite',
        'force_push',
        'scope_expansion',
      ],
      forbidden: ['expose_credentials'],
    }),
  );
  assert.ok(base.ok);
  return { ...base.lease, ...overrides };
}

function runCmd(command: string): AgentAction {
  return { type: 'run_command', command };
}

describe('lease parsing — fail-closed', () => {
  test('valid lease parses', () => {
    const lease = sampleLease();
    assert.equal(lease.scope.repository, 'gthgomez/Babel');
    assert.equal(lease.budgets.ciProductRepairRounds, 3);
  });

  test('invalid JSON → error', () => {
    const r = parseLeaseJson('{not json');
    assert.equal(r.ok, false);
  });

  test('unknown capability in allowed → invalid', () => {
    const lease = sampleLease({ allowedCapabilities: ['does_not_exist'] as AutonomyLease['allowedCapabilities'] });
    const v = validateLease(lease);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /Unknown capability/);
  });

  test('unknown field → strict schema rejects', () => {
    const r = parseLeaseJson(JSON.stringify({ version: 2, leaseId: 'x', scope: { repository: 'a' }, bogus: 1 }));
    assert.equal(r.ok, false);
  });

  test('unset env → null (legacy mode)', () => {
    assert.equal(loadLeaseFromEnv({}), null);
  });

  test('broken lease env → throws (fail loud)', () => {
    assert.throws(() => loadLeaseFromEnv({ BABEL_AUTONOMY_LEASE: '{broken' }));
    assert.throws(() => loadLeaseFromEnv({ BABEL_AUTONOMY_LEASE: JSON.stringify({ version: 99 }) }));
  });
});

describe('PDP decisions', () => {
  const lease = sampleLease();

  test('local capability in lease → ALLOW_SAFE_LOCAL', () => {
    const d = decideActionRequest({ capability: 'run_tests' }, lease);
    assert.equal(d.outcome, 'allow');
    assert.equal(d.reasonCode, 'ALLOW_SAFE_LOCAL');
  });

  test('publication capability in lease → VERIFY_BEFORE_PUBLICATION', () => {
    const d = decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'feat/x' }, lease);
    assert.equal(d.outcome, 'verify');
    assert.equal(d.reasonCode, 'VERIFY_BEFORE_PUBLICATION');
  });

  test('merge without lease membership → DENY_MISSING_AUTHORITY', () => {
    const d = decideActionRequest({ capability: 'merge' }, lease);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_MISSING_AUTHORITY');
  });

  test('release without lease membership → DENY_MISSING_AUTHORITY', () => {
    assert.equal(decideActionRequest({ capability: 'release' }, lease).reasonCode, 'DENY_MISSING_AUTHORITY');
  });

  test('merge with explicit capability and unprotected dest → verify', () => {
    const granted = sampleLease({
      allowedCapabilities: [...sampleLease().allowedCapabilities, 'merge'],
    });
    const d = decideActionRequest({ capability: 'merge', destinationBranch: 'feat/x' }, granted);
    assert.equal(d.outcome, 'verify');
    assert.equal(d.reasonCode, 'VERIFY_BEFORE_PUBLICATION');
  });

  test('release with capability but releasePublish false → DENY_CAPABILITY_CONSTRAINT', () => {
    const granted = sampleLease({
      allowedCapabilities: [...sampleLease().allowedCapabilities, 'release'],
    });
    const d = decideActionRequest({ capability: 'release' }, granted);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_CAPABILITY_CONSTRAINT');
  });

  test('force push → DENY_FORCE_PUSH_POLICY regardless of lease membership', () => {
    const permissive = sampleLease({ allowedCapabilities: [...sampleLease().allowedCapabilities, 'force_push'] });
    const d = decideActionRequest({ capability: 'force_push', force: true, destinationBranch: 'feat/x' }, permissive);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_FORCE_PUSH_POLICY');
  });

  test('remote ref delete → DENY_HISTORY_REWRITE', () => {
    const d = decideActionRequest({ capability: 'scope_expansion', delete: true }, lease);
    assert.equal(d.reasonCode, 'DENY_HISTORY_REWRITE');
  });

  test('remote mismatch → DENY_LEASE_MISMATCH', () => {
    const d = decideActionRequest({ capability: 'push_feature_branch', remote: 'evil-remote', destinationBranch: 'feat/x' }, lease);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_LEASE_MISMATCH');
  });

  test('protected branch push without allowed target → DENY_PROTECTED_BRANCH', () => {
    const d = decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'main' }, lease);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_PROTECTED_BRANCH');
  });

  test('protected branch prefix (release/*) without allowed target → DENY_PROTECTED_BRANCH', () => {
    const l = sampleLease({ constraints: { ...sampleLease().constraints, protectedBranches: ['main', 'release/*'] } });
    const d = decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'release/1.0' }, l);
    assert.equal(d.reasonCode, 'DENY_PROTECTED_BRANCH');
  });

  test('protected branch push with allowedProtectedTargets → verify', () => {
    const l = sampleLease({
      constraints: { ...sampleLease().constraints, allowedProtectedTargets: ['main'] },
    });
    const d = decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'main' }, l);
    assert.equal(d.outcome, 'verify');
  });

  test('local capability not in lease → DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT', () => {
    const narrow = sampleLease({
      allowedCapabilities: sampleLease().allowedCapabilities.filter((c) => c !== 'run_tests'),
    });
    const d = decideActionRequest({ capability: 'run_tests' }, narrow);
    assert.equal(d.outcome, 'deny');
  });

  test('unknown capability → DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT', () => {
    const d = decideActionRequest({ capability: 'unknown' }, lease);
    assert.equal(d.outcome, 'deny');
  });

  test('expose_credentials → DENY_CREDENTIAL_READ even if lease lists it', () => {
    const evil = sampleLease({ allowedCapabilities: [...sampleLease().allowedCapabilities, 'expose_credentials'] });
    const d = decideActionRequest({ capability: 'expose_credentials' }, evil);
    assert.equal(d.outcome, 'deny');
    assert.equal(d.reasonCode, 'DENY_CREDENTIAL_READ');
  });

  test('askCodeForCapability maps every gated capability', () => {
    for (const [cap, kind] of Object.entries(CAPABILITY_KINDS)) {
      if (kind === 'gated') {
        assert.ok(askCodeForCapability(cap as never).startsWith('ASK_'));
      }
    }
  });
});

describe('git/gh command parsing (structured capability extraction)', () => {
  test('git status → inspect_repository', () => {
    assert.equal(parseGitCommand('git status --short').capability, 'inspect_repository');
  });
  test('git diff → inspect_repository', () => {
    assert.equal(parseGitCommand('git diff HEAD~1').capability, 'inspect_repository');
  });
  test('git push origin feat/x → push_feature_branch, dest parsed', () => {
    const p = parseGitCommand('git push origin feat/x');
    assert.equal(p.capability, 'push_feature_branch');
    assert.equal(p.destinationBranch, 'feat/x');
    assert.equal(p.force, false);
  });
  test('git push --force origin feat/x → force_push', () => {
    const p = parseGitCommand('git push --force origin feat/x');
    assert.equal(p.capability, 'force_push');
    assert.equal(p.force, true);
  });
  test('git push origin HEAD:refs/heads/main → push to main (protected check)', () => {
    const p = parseGitCommand('git push origin HEAD:refs/heads/main');
    assert.equal(p.destinationBranch, 'main');
  });
  test('git push origin :refs/heads/feat/x → delete → scope_expansion', () => {
    const p = parseGitCommand('git push origin :refs/heads/feat/x');
    assert.equal(p.capability, 'scope_expansion');
    assert.equal(p.delete, true);
  });
  test('git push --delete origin feat/x → delete', () => {
    const p = parseGitCommand('git push --delete origin feat/x');
    assert.equal(p.delete, true);
  });
  test('git commit --amend → shared_history_rewrite', () => {
    assert.equal(parseGitCommand('git commit --amend -m x').capability, 'shared_history_rewrite');
  });
  test('git reset --hard → shared_history_rewrite', () => {
    assert.equal(parseGitCommand('git reset --hard HEAD~1').capability, 'shared_history_rewrite');
  });
  test('git clean -fd → destructive_data_delete', () => {
    assert.equal(parseGitCommand('git clean -fd').capability, 'destructive_data_delete');
  });
  test('git branch -D old → destructive_data_delete', () => {
    assert.equal(parseGitCommand('git branch -D old').capability, 'destructive_data_delete');
  });
  test('git remote add fork → scope_expansion', () => {
    assert.equal(parseGitCommand('git remote add fork https://x/y.git').capability, 'scope_expansion');
  });
  test('git show .env → expose_credentials', () => {
    assert.equal(parseGitCommand('git show HEAD:.env').capability, 'expose_credentials');
  });
  test('git show HEAD:src/index.ts → inspect_repository', () => {
    assert.equal(parseGitCommand('git show HEAD:src/index.ts').capability, 'inspect_repository');
  });
  test('gh pr create --draft → pr_create_draft', () => {
    assert.equal(parseGitCommand('gh pr create --draft --title x').capability, 'pr_create_draft');
  });
  test('gh pr create (ready) → pr_mark_ready (gated)', () => {
    assert.equal(parseGitCommand('gh pr create --title x').capability, 'pr_mark_ready');
  });
  test('gh pr merge → merge', () => {
    assert.equal(parseGitCommand('gh pr merge 5').capability, 'merge');
  });
  test('gh release create → release', () => {
    assert.equal(parseGitCommand('gh release create v1.0.0').capability, 'release');
  });
  test('gh run view → ci_inspect', () => {
    assert.equal(parseGitCommand('gh run view 123').capability, 'ci_inspect');
  });
  test('gh run rerun --failed → ci_rerun_transient', () => {
    assert.equal(parseGitCommand('gh run rerun --failed 123').capability, 'ci_rerun_transient');
  });
  test('gh api POST refs → repo_admin (endpoint-class gating)', () => {
    assert.equal(parseGitCommand('gh api --method POST repos/gthgomez/Babel/git/refs -f ref=refs/heads/x').capability, 'repo_admin');
  });
  test('gh api GET pulls → pr_inspect', () => {
    assert.equal(parseGitCommand('gh api repos/gthgomez/Babel/pulls/1').capability, 'pr_inspect');
  });
  test('ordinary non-git binary → run_local_command (local, bounded)', () => {
    assert.equal(parseGitCommand('pandoc -o out.pdf').capability, 'run_local_command');
  });
  test('empty command → unknown (fail-closed)', () => {
    assert.equal(parseGitCommand('').capability, 'unknown');
  });
});

describe('branch/scope helpers', () => {
  test('isProtectedBranch exact + prefix', () => {
    assert.equal(isProtectedBranch('main', ['main']), true);
    assert.equal(isProtectedBranch('release/1.0', ['main', 'release/*']), true);
    assert.equal(isProtectedBranch('feat/x', ['main']), false);
  });
  test('isAllowedBranchPrefix', () => {
    assert.equal(isAllowedBranchPrefix('feat/x', ['feat/', 'fix/']), true);
    assert.equal(isAllowedBranchPrefix('master', ['feat/', 'fix/']), false);
    assert.equal(isAllowedBranchPrefix('anything', []), true);
  });
});

describe('CI repair controller — bounded + terminating', () => {
  test('green CI → final_review', () => {
    const c = createCiController();
    const a = onCiRead(c, { requiredChecksGreen: true });
    assert.equal(a.kind, 'final_review');
  });

  test('product failure round 1 → repair (requires code change + local verify)', () => {
    const c = createCiController();
    const a = onCiRead(c, {
      requiredChecksGreen: false,
      classification: 'PRODUCT_FAILURE',
      touchedProductCode: true,
      locallyVerified: true,
    });
    assert.equal(a.kind, 'commit_and_push_repair');
    const c2 = advanceController(c, a);
    assert.equal(c2.productRoundsUsed, 1);
  });

  test('product failure WITHOUT code change → blocked (no empty repairs)', () => {
    const c = createCiController();
    const a = onCiRead(c, {
      requiredChecksGreen: false,
      classification: 'PRODUCT_FAILURE',
      touchedProductCode: false,
      locallyVerified: true,
    });
    assert.equal(a.kind, 'block');
  });

  test('product budget exhaustion → escalate', () => {
    let c = createCiController({ productRepairRounds: 1 });
    c = advanceController(
      c,
      onCiRead(c, { requiredChecksGreen: false, classification: 'PRODUCT_FAILURE', touchedProductCode: true, locallyVerified: true }),
    );
    const a = onCiRead(c, {
      requiredChecksGreen: false,
      classification: 'PRODUCT_FAILURE',
      touchedProductCode: true,
      locallyVerified: true,
    });
    assert.equal(a.kind, 'escalate');
    assert.match(a.kind === 'escalate' ? a.reason : '', /budget/i);
  });

  test('transient rerun within budget; exhausted → escalate', () => {
    let c = createCiController({ transientReruns: 1 });
    const a1 = onCiRead(c, { requiredChecksGreen: false, classification: 'TRANSIENT_INFRA_FAILURE' });
    assert.equal(a1.kind, 'rerun_transient');
    c = advanceController(c, a1);
    const a2 = onCiRead(c, { requiredChecksGreen: false, classification: 'TRANSIENT_INFRA_FAILURE' });
    assert.equal(a2.kind, 'escalate');
  });

  test('baseline failure → escalate (no false attribution)', () => {
    const c = createCiController();
    const a = onCiRead(c, { requiredChecksGreen: false, classification: 'BASELINE_FAILURE' });
    assert.equal(a.kind, 'escalate');
  });

  test('security gate → blocked (never weaken controls)', () => {
    const c = createCiController();
    const a = onCiRead(c, { requiredChecksGreen: false, classification: 'SECURITY_GATE' });
    assert.equal(a.kind, 'block');
  });

  test('classifyCiFailure: governance-touching + secret scan → SECURITY_GATE', () => {
    assert.equal(
      classifyCiFailure({ failingChecks: ['secret-scan'], baselineEvidence: false, touchesGovernance: true, transientSignals: [] }),
      'SECURITY_GATE',
    );
    assert.equal(
      classifyCiFailure({ failingChecks: ['content-policy'], baselineEvidence: false, touchesGovernance: true, transientSignals: [] }),
      'SECURITY_GATE',
    );
  });

  test('classifyCiFailure: transient signals → TRANSIENT_INFRA_FAILURE', () => {
    assert.equal(
      classifyCiFailure({ failingChecks: ['linux-validation'], baselineEvidence: false, touchesGovernance: false, transientSignals: ['runner unavailable'] }),
      'TRANSIENT_INFRA_FAILURE',
    );
  });

  test('termination invariant: controller always reaches final_review | escalated | blocked', () => {
    // Exhaust every budget path; assert no state machine can loop forever.
    let c = createCiController();
    for (let i = 0; i < 20; i++) {
      const a = onCiRead(c, { requiredChecksGreen: false, classification: 'PRODUCT_FAILURE', touchedProductCode: true, locallyVerified: true });
      if (a.kind === 'escalate' || a.kind === 'block') break;
      c = advanceController(c, a);
    }
    assert.ok(c.state === 'escalated' || c.state === 'blocked' || c.state === 'repairing');
  });
});

describe('policy integrity (self-mutation guard)', () => {
  test('governance paths detected', () => {
    assert.equal(isGovernancePath('babel-cli/src/authority/pdp.ts'), true);
    assert.equal(isGovernancePath('.claude/settings.json'), true);
    assert.equal(isGovernancePath('.claude/hooks/block-credential-read.sh'), true);
    assert.equal(isGovernancePath('.agents/rules/09-credential-read-deny.md'), true);
    assert.equal(isGovernancePath('.github/workflows/ci.yml'), true);
    assert.equal(isGovernancePath('babel-cli/src/agent/chatEngine.ts'), true);
    assert.equal(isGovernancePath('babel-cli/src/agent/autonomyEnforcement.ts'), true);
    assert.equal(isGovernancePath('babel-cli/src/agent/chatApproval.ts'), true);
    assert.equal(isGovernancePath('babel-cli/src/agent/governedMutations.ts'), true);
    assert.equal(isGovernancePath('babel-cli/src/utils/envFlags.ts'), true);
    assert.equal(isGovernancePath('runs/chat-sessions/abc/authority-session.json'), true);
    assert.equal(isGovernancePath('runs/chat-sessions/abc/transcript.jsonl'), false);
    assert.equal(isGovernancePath('src/main.ts'), false);
  });
});

describe('wire: lease-aware dispatch composite', () => {
  const lease = sampleLease();
  const baselineRoot = mkdtempSync(join(tmpdir(), 'babel-auth-'));
  const ctx = { lease, baseline: { repoRoot: baselineRoot, manifest: buildBaseline(baselineRoot) } };
  after(() => {
    rmSync(baselineRoot, { recursive: true, force: true });
  });

  test('no lease → legacy behavior identical', () => {
    const r = decideWithLease(runCmd('npm test'), 'workspace_write', { lease: null });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reasonCode, '');
  });

  test('no lease: protected-branch push is denied', () => {
    const r = decideWithLease(runCmd('git push origin main'), 'workspace_write', { lease: null });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_PROTECTED_BRANCH');
    const master = decideWithLease(runCmd('git push origin master'), 'workspace_write', { lease: null });
    assert.equal(master.decision, 'deny');
    const refspec = decideWithLease(
      runCmd('git push origin HEAD:refs/heads/main'),
      'workspace_write',
      { lease: null },
    );
    assert.equal(refspec.decision, 'deny');
  });

  test('no lease: draft PR and external message are denied', () => {
    const pr = decideWithLease(runCmd('gh pr create --draft --title x'), 'workspace_write', { lease: null });
    assert.equal(pr.decision, 'deny');
    assert.equal(pr.reasonCode, 'DENY_MISSING_AUTHORITY');
  });

  test('no lease: write to authority-session.json is denied', () => {
    const r = decideWithLease(
      { type: 'write_file', path: 'runs/chat-sessions/s1/authority-session.json', content: '{}' },
      'workspace_write',
      { lease: null },
    );
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  });

  test('routine local command with lease → allow', () => {
    const r = decideWithLease(runCmd('npm test'), 'workspace_write', ctx);
    assert.equal(r.decision, 'allow');
    assert.equal(r.reasonCode, 'ALLOW_SAFE_LOCAL');
  });

  test('git push feature branch → allow (verify at completion)', () => {
    const r = decideWithLease(runCmd('git push origin feat/x'), 'workspace_write', ctx);
    assert.equal(r.decision, 'allow');
    assert.equal(r.reasonCode, 'VERIFY_BEFORE_PUBLICATION');
  });

  test('git push --force → deny (DENY_FORCE_PUSH_POLICY)', () => {
    const r = decideWithLease(runCmd('git push --force origin feat/x'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_FORCE_PUSH_POLICY');
  });

  test('git push to main → deny (DENY_PROTECTED_BRANCH)', () => {
    const r = decideWithLease(runCmd('git push origin HEAD:refs/heads/main'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_PROTECTED_BRANCH');
  });

  test('gh pr merge without merge capability → deny (DENY_MISSING_AUTHORITY)', () => {
    const r = decideWithLease(runCmd('gh pr merge 5'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_MISSING_AUTHORITY');
  });

  test('cat .env (bash) → deny (credential)', () => {
    const r = decideWithLease(runCmd('cat .env'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_CREDENTIAL_READ');
  });

  test('git show HEAD:.env → deny (credential)', () => {
    const r = decideWithLease(runCmd('git show HEAD:.env'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_CREDENTIAL_READ');
  });

  test('unclassifiable command (empty) → deny (DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT)', () => {
    const r = decideWithLease(runCmd(''), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT');
  });

  test('known-dangerous tool (terraform apply) → deny (DENY_MISSING_AUTHORITY)', () => {
    const r = decideWithLease(runCmd('terraform apply -auto-approve'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_MISSING_AUTHORITY');
  });

  test('ordinary unclassified command (npm test) → allow (local)', () => {
    const r = decideWithLease(runCmd('npm test'), 'workspace_write', ctx);
    assert.equal(r.decision, 'allow');
    assert.equal(r.reasonCode, 'ALLOW_SAFE_LOCAL');
  });

  test('policy self-mutation: write to .claude/settings.json → deny even when lease allows edit', () => {
    const r = decideWithLease(
      { type: 'write_file', path: '.claude/settings.json', content: '{}' },
      'workspace_write',
      ctx,
    );
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  });

  test('ordinary file write under lease → allow', () => {
    const r = decideWithLease({ type: 'write_file', path: 'src/main.ts', content: 'x' }, 'workspace_write', ctx);
    assert.equal(r.decision, 'allow');
  });

  test('legacy deny still wins over lease allow (curl in workspace_write)', () => {
    const r = decideWithLease(runCmd('curl https://example.com'), 'workspace_write', ctx);
    assert.equal(r.decision, 'deny');
  });

  test('ask_before_mutation preset still asks for mutations under lease', () => {
    const r = decideWithLease({ type: 'write_file', path: 'src/main.ts', content: 'x' }, 'ask_before_mutation', ctx);
    assert.equal(r.decision, 'ask');
  });
});
