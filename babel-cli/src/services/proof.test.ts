import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildProofStatus, writeProofArtifacts } from './proof.js';

function makeRunDir(name: string): string {
  const runDir = mkdtempSync(join(tmpdir(), `babel-proof-${name}-`));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '01_manifest.json'), JSON.stringify({
    target_project: 'test_project',
    analysis: {
      pipeline_mode: 'verified',
      task_summary: 'Fix the test',
    },
  }), 'utf-8');
  return runDir;
}

test('buildProofStatus marks changed run with passing verifier as COMPLETE_VERIFIED', () => {
  const runDir = makeRunDir('verified');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'COMPLETE',
    pipeline_mode: 'autonomous',
    qa_verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_COMPLETE',
    steps_executed: 2,
    tool_call_log: [
      { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test -- auth', exit_code: 0, verified: true },
    ],
  }), 'utf-8');
  writeFileSync(join(runDir, 'terminal_status_summary.json'), JSON.stringify({
    status: 'COMPLETE',
    changed_files: ['src/auth.ts'],
  }), 'utf-8');

  const proof = buildProofStatus(runDir);

  assert.equal(proof.proof_status, 'COMPLETE_VERIFIED');
  assert.equal(proof.execution_happened, true);
  assert.equal(proof.tests_run, true);
  assert.equal(proof.tests_passed, true);
  assert.deepEqual(proof.changed_files, ['src/auth.ts']);
});

test('buildProofStatus rejects completion claim when changed files lack verifier proof', () => {
  const runDir = makeRunDir('missing-tests');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'COMPLETE',
    pipeline_mode: 'autonomous',
    qa_verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_COMPLETE',
    steps_executed: 1,
    tool_call_log: [
      { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
    ],
  }), 'utf-8');

  const proof = buildProofStatus(runDir);

  assert.equal(proof.proof_status, 'CLAIMED_BUT_NOT_PROVEN');
  assert.equal(proof.tests_run, false);
  assert.match(proof.decision_reasons.join('\n'), /no verifier\/test command/i);
});

test('buildProofStatus reads numerically latest QA verdict artifact', () => {
  const runDir = makeRunDir('qa-numeric-sort');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'COMPLETE',
    pipeline_mode: 'autonomous',
  }), 'utf-8');
  writeFileSync(join(runDir, '03_qa_verdict_v9.json'), JSON.stringify({
    verdict: 'FAIL',
  }), 'utf-8');
  writeFileSync(join(runDir, '03_qa_verdict_v10.json'), JSON.stringify({
    verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_COMPLETE',
    steps_executed: 2,
    tool_call_log: [
      { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test -- auth', exit_code: 0, verified: true },
    ],
  }), 'utf-8');
  writeFileSync(join(runDir, 'terminal_status_summary.json'), JSON.stringify({
    status: 'COMPLETE',
    changed_files: ['src/auth.ts'],
  }), 'utf-8');

  const proof = buildProofStatus(runDir);

  assert.equal(proof.qa_passed, true);
  assert.equal(proof.proof_status, 'COMPLETE_VERIFIED');
});

test('writeProofArtifacts refuses to write into non-run directories', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-not-run-'));

  assert.throws(
    () => writeProofArtifacts(runDir),
    /not a Babel run evidence directory/,
  );
  assert.equal(existsSync(join(runDir, 'proof_status.json')), false);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), false);
});

test('writeProofArtifacts writes proof_status and markdown report for failed verifier', () => {
  const runDir = makeRunDir('failed');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'FAILED',
    pipeline_mode: 'autonomous',
    qa_verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_HALTED',
    steps_executed: 2,
    tool_call_log: [
      { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test -- auth', exit_code: 1, verified: false },
    ],
  }), 'utf-8');

  const artifacts = writeProofArtifacts(runDir);
  const proofText = readFileSync(artifacts.proofStatusPath, 'utf-8');
  const reportText = readFileSync(artifacts.reportPath, 'utf-8');

  assert.equal(artifacts.proof.proof_status, 'FAILED_TESTS');
  assert.equal(existsSync(join(runDir, 'proof_status.json')), true);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), true);
  assert.match(proofText, /FAILED_TESTS/);
  assert.match(reportText, /# BABEL_RUN_REPORT/);
});
