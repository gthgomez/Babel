import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const cliRoot = resolve(dirname(thisFile), '..', '..');
const entry = join(cliRoot, 'src', 'index.ts');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: cliRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('top-level help is user-shaped before internals', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ask[\s\S]*without[\s\S]*editing/i);
  assert.match(result.stdout, /plan[\s\S]*without[\s\S]*editing/i);
  assert.match(result.stdout, /fix .*focused safe edit/i);
  assert.match(result.stdout, /babel "<task\.\.\.>"/);
  assert.doesNotMatch(result.stdout, /\bmcp\s+Manage MCP/);
});

test('advanced tier keeps internal commands discoverable', () => {
  const result = runCli(['advanced']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Babel Advanced Commands/);
  assert.match(result.stdout, /simplify .*cleanup audit/i);
  assert.match(result.stdout, /docs .*documentation authority/i);
  assert.match(result.stdout, /mcp .*MCP/i);
  assert.match(result.stdout, /benchmark .*benchmark/i);
  assert.match(result.stdout, /ship/i);
});

test('docs audit command emits deterministic JSON', () => {
  const result = runCli(['docs', 'audit', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    summary: { errors: number; warnings: number; checkedDocs: number };
  };
  assert.equal(payload.status, 'pass');
  assert.equal(payload.summary.errors, 0);
  assert.equal(payload.summary.warnings, 0);
  assert.ok(payload.summary.checkedDocs > 0);
});

test('simplify command emits deterministic JSON without model calls', () => {
  const result = runCli(['simplify', 'babel-cli/src/cli/argv.ts', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    schema_version: number;
    proof: { no_model_call: boolean; docs_audit_status: string; source_provenance_status: string };
    scan: { mode: string; target: string | null };
  };
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.proof.no_model_call, true);
  assert.equal(payload.proof.docs_audit_status, 'pass');
  assert.equal(payload.proof.source_provenance_status, 'pass');
  assert.equal(payload.scan.mode, 'target');
});

test('Lite help teaches propose before patch compatibility', () => {
  const result = runCli(['lite', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bl fix "Fix failing tests"/);
  assert.match(result.stdout, /bl propose "Propose the smallest safe diff"/);
  assert.match(result.stdout, /bl review/);
  assert.match(result.stdout, /bl undo/);
  assert.match(result.stdout, /fix .*focused fix/i);
});

test('ship help exposes the guarded GitHub workflow', () => {
  const result = runCli(['ship', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guarded AGENTS\.md/i);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--allow-remote/);
  assert.match(result.stdout, /Hard stops include/);
});

function writeProofFixture(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '01_manifest.json'), JSON.stringify({
    target_project: 'test_project',
    analysis: {
      pipeline_mode: 'autonomous',
      task_summary: 'Fix the command smoke test',
    },
  }), 'utf-8');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'COMPLETE',
    pipeline_mode: 'autonomous',
    qa_verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_COMPLETE',
    steps_executed: 2,
    tool_call_log: [
      { tool: 'file_write', target: 'src/example.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test -- example', exit_code: 0, verified: true },
    ],
  }), 'utf-8');
  return runDir;
}

function writeFailedProofFixture(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-failed-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '01_manifest.json'), JSON.stringify({
    target_project: 'test_project',
    analysis: {
      pipeline_mode: 'autonomous',
      task_summary: 'Fix the failing command smoke test',
    },
  }), 'utf-8');
  writeFileSync(join(runDir, '06_runtime_telemetry.json'), JSON.stringify({
    final_outcome: 'FAILED',
    pipeline_mode: 'autonomous',
    qa_verdict: 'PASS',
  }), 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), JSON.stringify({
    status: 'EXECUTION_HALTED',
    steps_executed: 2,
    tool_call_log: [
      { tool: 'file_write', target: 'src/example.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test -- example', exit_code: 1, verified: false },
    ],
  }), 'utf-8');
  return runDir;
}

test('prove command writes proof artifacts for an explicit run directory', () => {
  const runDir = writeProofFixture();
  const result = runCli(['prove', runDir, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COMPLETE_VERIFIED/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), true);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), true);
});

test('inspect --report writes proof artifacts from the inspection surface', () => {
  const runDir = writeProofFixture();
  const result = runCli(['inspect', '--report', '--run', runDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STATUS: COMPLETE_VERIFIED/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), true);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), true);
});

test('prove refuses to write proof artifacts into non-run directories', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-not-run-'));
  const result = runCli(['prove', runDir, '--json']);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not a Babel run evidence directory/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), false);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), false);
});

test('learn from-run writes a learning failure record', () => {
  const runDir = writeProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const result = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO_FAILURE_DETECTED/);
  assert.equal(existsSync(join(learningRoot, 'failures')), true);
});

test('learn inspect reads a learning failure record by run id', () => {
  const runDir = writeProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const create = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(create.status, 0, create.stderr);
  const runId = runDir.split(/[\\/]/).pop();
  assert.ok(runId);

  const inspect = runCli(['learn', 'inspect', runId, '--learning-root', learningRoot, '--json']);

  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /babel_learning_failure/);
  assert.match(inspect.stdout, /NO_FAILURE_DETECTED/);
});

test('learn propose, test, promote, and inspect support shadow lesson lifecycle', () => {
  const runDir = writeFailedProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const create = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(create.status, 0, create.stderr);
  const runId = runDir.split(/[\\/]/).pop();
  assert.ok(runId);

  const propose = runCli(['learn', 'propose', runId, '--learning-root', learningRoot, '--json']);
  assert.equal(propose.status, 0, propose.stderr);
  assert.match(propose.stdout, /babel_lesson_candidate/);
  const proposed = JSON.parse(propose.stdout) as { lesson: { lesson_id: string } };
  const lessonId = proposed.lesson.lesson_id;

  const evaluated = runCli(['learn', 'test', lessonId, '--learning-root', learningRoot, '--json']);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.match(evaluated.stdout, /babel_lesson_eval/);
  assert.match(evaluated.stdout, /"status": "passed"/);

  const promoted = runCli(['learn', 'promote', lessonId, '--shadow', '--learning-root', learningRoot, '--json']);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.match(promoted.stdout, /"status": "shadow"/);

  const packaged = runCli(['learn', 'package', lessonId, '--target', 'project-verifier-contract', '--learning-root', learningRoot, '--json']);
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.match(packaged.stdout, /babel_mutation_package/);
  assert.match(packaged.stdout, /approval_identity_sha256/);

  const inspect = runCli(['learn', 'inspect', lessonId, '--learning-root', learningRoot, '--json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /babel_lesson_candidate/);
  assert.match(inspect.stdout, /"status": "shadow"/);
});
