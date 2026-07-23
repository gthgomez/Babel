import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runProductionBenchmark } from './productionBenchmark.js';

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-production-benchmark-'));
}

function writeSubagentPluginPublicProof(
  path: string,
  overrides: {
    status?: 'pass' | 'partial' | 'fail';
    subagentStatus?: 'pass' | 'partial' | 'fail';
    pluginStatus?: 'pass' | 'partial' | 'fail';
    publicStatus?: 'pass' | 'partial' | 'fail';
  },
): void {
  write(
    path,
    JSON.stringify(
      {
        schema_version: 1,
        artifact_type: 'babel_production_subagent_plugin_public_proof',
        status: overrides.status ?? 'partial',
        claim_scope:
          'DeepSeek-backed governed Babel CLI/control-plane lane with live subagents excluded unless explicitly opted in',
        subagents: {
          readonly: {
            status: overrides.subagentStatus ?? 'pass',
            evidence: [
              'src/services/agentTeams.test.ts',
              'src/services/agentTeams.ts',
              'docs/status/BABEL_P8_P11_IMPLEMENTATION_EVIDENCE_2026-06-05.md',
            ],
          },
        },
        plugins: {
          strict: {
            status: overrides.pluginStatus ?? 'partial',
            evidence: [
              'tests/fixtures/plugin-proofs/third-party-plugin-corpus/readonly/plugin.json',
              'tests/fixtures/plugin-proofs/third-party-plugin-corpus/local-mutating/plugin.json',
              'tests/fixtures/plugin-proofs/third-party-plugin-corpus/enterprise-blocked/plugin.json',
            ],
            notes: 'Third-party fixture proof status is tracked by this proof file.',
          },
          remaining:
            'Plugin strict proof remains partial until strict-mode distribution is recorded.',
        },
        public_export: {
          strict: {
            status: overrides.publicStatus ?? 'partial',
            evidence: ['tools/test-export-babel-public.ps1', 'tools/check-public-scrub.ps1'],
            notes:
              'Strict public-export scrub mode should remain pass-only for warning-free exports.',
          },
          remaining: 'Legacy warning fixtures remain regression-only.',
        },
        blocking_reason:
          'Subagent readonly proof, plugin strict proof, and public strict scrub proof are required before scoped production wording.',
      },
      null,
      2,
    ),
  );
}

test('production benchmark stays claim-blocked when proof artifacts are missing', () => {
  const root = makeRoot();
  const outputDir = join(root, 'out');
  const statusRoot = join(root, 'status');
  const proofRoot = join(statusRoot, 'production-proof');
  const packageJsonPath = join(root, 'package.json');
  write(packageJsonPath, JSON.stringify({ scripts: {} }, null, 2));

  const report = runProductionBenchmark({
    outputDir,
    statusRoot,
    proofRoot,
    packageJsonPath,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.benchmark_type, 'babel_cli_production_readiness');
  assert.equal(report.summary.claim_ready, false);
  assert.ok(report.summary.blocking_failures > 0);
  assert.equal(report.summary.skipped, 0);
  assert.equal(report.skipped_gates.length, 0);
  assert.ok(report.blocking_failures.includes('live_governance_breadth'));
  assert.ok(report.blocking_failures.includes('subagent_plugin_public_strict'));

  const written = JSON.parse(readFileSync(report.artifact_path, 'utf8')) as {
    summary?: { claim_ready?: boolean };
  };
  assert.equal(written.summary?.claim_ready, false);
});

test('production benchmark requires subagent readonly, plugin strict, and public strict proof to pass', () => {
  const root = makeRoot();
  const outputDir = join(root, 'out');
  const statusRoot = join(root, 'status');
  const proofRoot = join(statusRoot, 'production-proof');
  const packageJsonPath = join(root, 'package.json');

  write(
    packageJsonPath,
    JSON.stringify(
      {
        scripts: {
          'test:live-governance:required': 'node scripts/run_governance_tests.mjs',
        },
      },
      null,
      2,
    ),
  );
  write(
    join(statusRoot, 'BABEL_P8_P11_IMPLEMENTATION_EVIDENCE_2026-06-05.md'),
    [
      'npm --prefix .\\babel-cli run typecheck',
      'npm --prefix .\\babel-cli run build',
      'npm --prefix .\\babel-cli run test:unit',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_PUBLIC_EXPORT_PROOF_2026-06-05.md'),
    [
      'powershell -ExecutionPolicy Bypass -File .\\tools\\validate-catalog.ps1',
      'scrub checker pass/fail boundary',
      'npm run test:public-release',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_ROADMAP_REMAINING_PROOF_PLAN_2026-06-05.md'),
    [
      '`node .\\babel-cli\\dist\\index.js doctor --scope all --json` is non-red',
      '`node .\\babel-cli\\dist\\index.js benchmark product --json` is green at `27/27`',
    ].join('\n'),
  );
  write(
    join(proofRoot, 'live-governance-breadth-proof.json'),
    JSON.stringify({ status: 'pass' }, null, 2),
  );
  write(
    join(proofRoot, 'verifier-rollback-proof.json'),
    JSON.stringify(
      {
        verifier_universality: { status: 'pass' },
        hostile_rollback_corpus: { status: 'pass' },
      },
      null,
      2,
    ),
  );
  writeSubagentPluginPublicProof(join(proofRoot, 'subagent-plugin-public-proof.json'), {
    status: 'partial',
    subagentStatus: 'pass',
    pluginStatus: 'partial',
    publicStatus: 'pass',
  });

  const report = runProductionBenchmark({
    outputDir,
    statusRoot,
    proofRoot,
    packageJsonPath,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.summary.claim_ready, false);
  assert.equal(report.blocking_failures.includes('subagent_plugin_public_strict'), true);
  const gate = report.gates.find((entry) => entry.id === 'subagent_plugin_public_strict');
  assert.equal(gate?.status, 'warn');
  assert.match(gate?.message ?? '', /plugin strict proof/);
});

test('production benchmark becomes claim-ready only with all required proof artifacts', () => {
  const root = makeRoot();
  const outputDir = join(root, 'out');
  const statusRoot = join(root, 'status');
  const proofRoot = join(statusRoot, 'production-proof');
  const packageJsonPath = join(root, 'package.json');

  write(
    packageJsonPath,
    JSON.stringify(
      {
        scripts: {
          'test:live-governance:required':
            'node scripts/run_live_governance_tests.mjs --required-deepseek',
        },
      },
      null,
      2,
    ),
  );
  write(
    join(statusRoot, 'BABEL_P8_P11_IMPLEMENTATION_EVIDENCE_2026-06-05.md'),
    [
      'npm --prefix .\\babel-cli run typecheck',
      'npm --prefix .\\babel-cli run build',
      'npm --prefix .\\babel-cli run test:unit',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_PUBLIC_EXPORT_PROOF_2026-06-05.md'),
    [
      'powershell -ExecutionPolicy Bypass -File .\\tools\\validate-catalog.ps1',
      'scrub checker pass/fail boundary',
      'npm run test:public-release',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_ROADMAP_REMAINING_PROOF_PLAN_2026-06-05.md'),
    [
      '`node .\\babel-cli\\dist\\index.js doctor --scope all --json` is non-red',
      '`node .\\babel-cli\\dist\\index.js benchmark product --json` is green at `27/27`',
    ].join('\n'),
  );
  write(
    join(proofRoot, 'live-governance-breadth-proof.json'),
    JSON.stringify({ status: 'pass' }, null, 2),
  );
  write(
    join(proofRoot, 'verifier-rollback-proof.json'),
    JSON.stringify(
      {
        verifier_universality: { status: 'pass' },
        hostile_rollback_corpus: { status: 'pass' },
      },
      null,
      2,
    ),
  );
  writeSubagentPluginPublicProof(join(proofRoot, 'subagent-plugin-public-proof.json'), {
    status: 'pass',
    subagentStatus: 'pass',
    pluginStatus: 'pass',
    publicStatus: 'pass',
  });

  const report = runProductionBenchmark({
    outputDir,
    statusRoot,
    proofRoot,
    packageJsonPath,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.summary.blocking_failures, 0);
  assert.equal(report.summary.skipped, 0);
  assert.equal(report.summary.required, 8);
  assert.equal(report.summary.claim_ready, true);
  assert.equal(report.skipped_gates.length, 0);
  assert.match(report.safe_wording, /DeepSeek-backed.*Coding Agent/);
});

test('production benchmark never becomes claim-ready when a required gate is skipped', () => {
  const root = makeRoot();
  const outputDir = join(root, 'out');
  const statusRoot = join(root, 'status');
  const proofRoot = join(statusRoot, 'production-proof');
  const packageJsonPath = join(root, 'package.json');

  write(
    packageJsonPath,
    JSON.stringify(
      {
        scripts: {
          'test:live-governance:required':
            'node scripts/run_live_governance_tests.mjs --required-deepseek',
          'test:public-release': 'node scripts/test_public_release.mjs',
        },
      },
      null,
      2,
    ),
  );
  write(
    join(statusRoot, 'BABEL_P8_P11_IMPLEMENTATION_EVIDENCE_2026-06-05.md'),
    [
      'npm --prefix .\\babel-cli run typecheck',
      'npm --prefix .\\babel-cli run build',
      'npm --prefix .\\babel-cli run test:unit',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_PUBLIC_EXPORT_PROOF_2026-06-05.md'),
    [
      'powershell -ExecutionPolicy Bypass -File .\\tools\\validate-catalog.ps1',
      'scrub checker pass/fail boundary',
      'npm run test:public-release',
    ].join('\n'),
  );
  write(
    join(statusRoot, 'BABEL_ROADMAP_REMAINING_PROOF_PLAN_2026-06-05.md'),
    [
      '`node .\\babel-cli\\dist\\index.js doctor --scope all --json` is non-red',
      '`node .\\babel-cli\\dist\\index.js benchmark product --json` is green at `27/27`',
    ].join('\n'),
  );
  write(
    join(proofRoot, 'live-governance-breadth-proof.json'),
    JSON.stringify({ status: 'pass' }, null, 2),
  );
  write(
    join(proofRoot, 'verifier-rollback-proof.json'),
    JSON.stringify(
      {
        verifier_universality: { status: 'pass' },
        hostile_rollback_corpus: { status: 'pass' },
      },
      null,
      2,
    ),
  );

  const report = runProductionBenchmark({
    outputDir,
    statusRoot,
    proofRoot,
    packageJsonPath,
    skipGateIds: ['subagent_plugin_public_strict'],
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.summary.claim_ready, false);
  assert.equal(report.summary.skipped, 1);
  assert.equal(
    report.skipped_gates.some((gate) => gate === 'subagent_plugin_public_strict'),
    true,
  );
  const skippedGate = report.gates.find((gate) => gate.id === 'subagent_plugin_public_strict');
  assert.equal(skippedGate?.status, 'skip');
  assert.equal(skippedGate?.required, true);
  assert.equal(skippedGate?.skipped, true);
  assert.equal(skippedGate?.evidence_path, null);
});
