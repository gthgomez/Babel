import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Migration tests evaluate each immutable contract independently. An older base
// must keep its own protections; it need not implement the candidate's fields.
const trustedBaseSha = process.env.BABEL_TRUSTED_BASE_SHA;
const fixture = {
  schema_version: 3, kind: 'independent_agent_review_v3', provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
  repository: 'gthgomez/Babel', pr_number: 152, base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40),
  candidate_digest: 'c'.repeat(64), diff_numstat_digest: 'd'.repeat(64), task_id: 'fixture-task', task_hash: 'e'.repeat(64),
  builder: { kind: 'codex', principal_id: 'builder', execution_id: 'builder-execution' },
  reviewer: { kind: 'codex', principal_id: 'reviewer', execution_id: 'reviewer-execution' },
  controller_run_id: 'fixture-controller', challenge_id: 'fixture-challenge',
  runtime: {
    agent_kind: 'codex', adapter_id: 'test-fixture', controller_execution_id: 'reviewer-execution',
    execution_purpose: 'FINAL_CERTIFICATION', requested_provider: 'unknown', observed_provider: 'unknown',
    requested_model: 'unknown', observed_model: 'unknown', model_attribution: 'unknown',
    provider_execution_id: 'child-execution', session_id: 'child-session', parent_execution_id: 'builder-execution',
    source_sha: 'b'.repeat(40), fresh_context: true, read_only_enforced: true,
  },
  review_mode: 'exact_diff', execution_purpose: 'FINAL_CERTIFICATION', reviewed_at: new Date().toISOString(),
  scope: ['scripts/agent-pr-gate.ps1'], verdict: 'APPROVE', findings: [], blocking_findings: [],
  isolation: { candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
};

function evaluateContract(evidence: object, baseSha?: string): { valid: boolean; errors: string[] } {
  const directory = mkdtempSync(path.join(tmpdir(), 'babel-review-contract-'));
  try {
    const evidencePath = path.join(directory, 'fixture.json');
    const evaluatorPath = path.join(directory, 'agent-review-evidence.ps1');
    const baseModulePath = path.join(directory, 'agent-pr-gate-common.psm1');
    writeFileSync(evidencePath, JSON.stringify(evidence));
    if (baseSha) {
      assert.match(baseSha, /^[0-9a-f]{40}$/);
      writeFileSync(baseModulePath, execFileSync('git', ['--no-replace-objects', 'show', `${baseSha}:scripts/agent-pr-gate-common.psm1`], { cwd: repoRoot, encoding: 'utf8' }));
      // Never substitute candidate/HEAD for the workflow's immutable base.
      writeFileSync(evaluatorPath, execFileSync('git', ['--no-replace-objects', 'show', `${baseSha}:scripts/agent-review-evidence.ps1`], {
        cwd: repoRoot, encoding: 'utf8',
      }));
    }
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module ${quote(baseSha ? baseModulePath : path.join(repoRoot, 'scripts/agent-pr-gate-common.psm1'))} -Force`,
      `$evidence = Get-Content -Raw ${quote(evidencePath)} | ConvertFrom-Json -Depth 40`,
      "Test-AgentIndependentReviewEvidenceV3 -Evidence $evidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha ('b' * 40) -HeadSha ('a' * 40) -ExpectedNumstatDigest ('d' * 64) -ExpectedCandidateDigest ('c' * 64) -ExpectedScope @('scripts/agent-pr-gate.ps1')" + (baseSha ? "" : " -ExpectedDiffSha256 ('f' * 64) -ExpectedDiffLines 2") + " | ConvertTo-Json -Compress",
    ].join('\n');
    return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: repoRoot, encoding: 'utf8' }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const candidateFixture = {
  ...fixture, runtime: { ...fixture.runtime, fresh_process: true },
  coverage: { diff_consumed: true, diff_sha256: 'f'.repeat(64), diff_lines_total: 2, diff_lines_read: 2, changed_paths: 1, source_paths_opened: [] },
};

test('immutable base preserves a supported V3 contract and rejects wrong-head and BLOCK evidence during migration', { skip: !trustedBaseSha }, () => {
  // Versioned fixtures: test both existing V3 and the extended V3 contract.
  // Promotion must remain testable when a later base adopts the new contract.
  const legacy = evaluateContract(fixture, trustedBaseSha);
  const extended = evaluateContract(candidateFixture, trustedBaseSha);
  assert.ok(legacy.valid || extended.valid, `base supports neither known contract: ${[...legacy.errors, ...extended.errors].join(', ')}`);
  const supported = extended.valid ? candidateFixture : fixture;
  assert.equal(evaluateContract({ ...supported, head_sha: 'f'.repeat(40) }, trustedBaseSha).valid, false);
  assert.equal(evaluateContract({ ...supported, verdict: 'BLOCK', blocking_findings: ['fixture blocker'] }, trustedBaseSha).valid, false);
});

test('candidate V3 evaluator enforces new coverage and fresh-process fields without borrowing base authority', () => {
  assert.equal(evaluateContract(candidateFixture).valid, true);
  assert.equal(evaluateContract({ ...candidateFixture, coverage: { ...candidateFixture.coverage, diff_sha256: '0'.repeat(64) } }).valid, false);
  const partial = { ...candidateFixture, coverage: { ...candidateFixture.coverage, diff_consumed: false } };
  assert.equal(evaluateContract(partial).valid, false);
  assert.equal(evaluateContract({ ...candidateFixture, runtime: { ...candidateFixture.runtime, fresh_process: false } }).valid, false);
  assert.equal(evaluateContract({ ...candidateFixture, head_sha: 'f'.repeat(40) }).valid, false);
});
