import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyReviewRisk, resolveReviewPolicy } from './reviewPolicy.js';
import { resolveRequiredGates } from './mergeReadinessBroker.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shared = JSON.parse(readFileSync(path.join(repoRoot, 'config/review-risk-policy.json'), 'utf8')) as {
  finalCertificationCount: Record<string, number>;
  hostProtectedPrefixes: string[];
};

test('review control plane: TypeScript, candidate PowerShell gate, and shared policy agree', () => {
  const modulePath = path.join(repoRoot, 'scripts/agent-pr-gate-common.psm1').replaceAll("'", "''");
  const expression = [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module -Name '${modulePath}' -Force`,
    '$value = [ordered]@{',
    "  normal = Get-AgentMinimumReviewCount -Lane GREEN",
    "  elevated = Get-AgentMinimumReviewCount -Lane YELLOW",
    "  critical = Get-AgentMinimumReviewCount -Lane RED",
    "  ordinary = Get-AgentRiskLane -ChangedPaths @('babel-cli/src/ui/ordinary.ts')",
    "  control = Get-AgentRiskLane -ChangedPaths @('scripts/agent-pr-gate.ps1')",
    '}',
    '$value | ConvertTo-Json -Compress',
  ].join('\n');
  const powershell = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', expression], {
    cwd: repoRoot, encoding: 'utf8',
  })) as { normal: number; elevated: number; critical: number; ordinary: string; control: string };

  const mappings = [
    { lane: 'NORMAL' as const, ps: powershell.normal },
    { lane: 'ELEVATED' as const, ps: powershell.elevated },
    { lane: 'CRITICAL' as const, ps: powershell.critical },
  ];
  for (const { lane, ps } of mappings) {
    const policy = resolveReviewPolicy({ riskLane: lane, requireAuthoritative: true });
    assert.equal(policy.finalCertificationCount, shared.finalCertificationCount[lane], `${lane}: TypeScript/shared count`);
    assert.equal(policy.finalCertificationCount, ps, `${lane}: TypeScript/PowerShell count`);
    assert.equal(resolveRequiredGates(lane).codeReview.minApprovals, policy.workingReviewCount, `${lane}: merge broker count`);
  }
  assert.equal(powershell.ordinary, 'GREEN');
  assert.equal(classifyReviewRisk(['babel-cli/src/ui/ordinary.ts']), 'NORMAL');
  assert.equal(powershell.control, 'RED');
  assert.equal(classifyReviewRisk(['scripts/agent-pr-gate.ps1']), 'CRITICAL');
});

test('every host-protected prefix and empty scope classify conservatively in PowerShell', () => {
  const modulePath = path.join(repoRoot, 'scripts/agent-pr-gate-common.psm1').replaceAll("'", "''");
  const expression = [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module -Name '${modulePath}' -Force`,
    "$policy = Get-Content -Raw -LiteralPath 'config/review-risk-policy.json' | ConvertFrom-Json",
    "$lanes = @($policy.hostProtectedPrefixes | ForEach-Object { Get-AgentRiskLane -ChangedPaths @($_) })",
    "$result = [ordered]@{ empty = Get-AgentRiskLane -ChangedPaths @(); lanes = $lanes }",
    '$result | ConvertTo-Json -Compress -Depth 5',
  ].join('\n');
  const powershell = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', expression], {
    cwd: repoRoot, encoding: 'utf8',
  })) as { empty: string; lanes: string[] };
  assert.equal(powershell.empty, 'BLACK');
  assert.deepEqual(powershell.lanes, shared.hostProtectedPrefixes.map(() => 'RED'));
  for (const prefix of shared.hostProtectedPrefixes) {
    assert.equal(classifyReviewRisk([prefix]), 'CRITICAL', prefix);
  }
});

const trustedBaseSha = process.env.BABEL_TRUSTED_BASE_SHA;
test('trusted base gate accepts exact-diff coverage and fresh process evidence', { skip: !trustedBaseSha }, () => {
  assert.match(trustedBaseSha!, /^[0-9a-f]{40}$/);
  const evidence = execFileSync('git', ['--no-replace-objects', 'show', `${trustedBaseSha}:scripts/agent-review-evidence.ps1`], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.ok(/'coverage'/.test(evidence), 'trusted base gate rejects the candidate V3 coverage field');
  assert.ok(/fresh_process/.test(evidence), 'trusted base gate does not check fresh child process');
});

test('trusted base gate requires the critical review count', { skip: !trustedBaseSha }, () => {
  const gate = execFileSync('git', ['--no-replace-objects', 'show', `${trustedBaseSha}:scripts/agent-pr-gate.ps1`], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.ok(!/\$minimumReviewCount\s*=\s*1\b/.test(gate), 'trusted base gate requires only one critical reviewer');
});
