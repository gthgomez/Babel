import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildProofStatus } from './proof.js';
import type { ProofStatus, ProofStatusArtifact } from './proof.js';
import {
  buildLearningFailureRecord,
  generateMutationPackage,
  lessonContentHash,
  promoteLessonToShadow,
  readLearningArtifact,
  readLearningFailureRecord,
  readLessonCandidate,
  testLessonCandidate,
  writeLearningFailureRecord,
  writeLessonCandidate,
} from './learning.js';

function makeRunDir(name: string): string {
  const runDir = mkdtempSync(join(tmpdir(), `babel-learning-${name}-`));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '01_manifest.json'),
    JSON.stringify({
      target_project: 'test_project',
      analysis: {
        pipeline_mode: 'deep',
        task_summary: 'Fix the learning test',
      },
    }),
    'utf-8',
  );
  return runDir;
}

function proofFixture(
  overrides: Partial<ProofStatusArtifact> & { proof_status: ProofStatus },
): ProofStatusArtifact {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-learning-proof-'));
  return {
    schema_version: 1,
    artifact_type: 'babel_proof_status',
    generated_at: '2026-06-04T00:00:00.000Z',
    run_dir: runDir,
    run_id: runDir.split(/[\\/]/).pop() ?? 'run',
    task: 'Classify proof',
    project: 'test_project',
    mode: 'deep',
    claimed_status: overrides.proof_status,
    observed_status: overrides.proof_status,
    execution_happened: false,
    qa_passed: null,
    tests_run: false,
    tests_passed: null,
    changed_files: [],
    commands_run: [],
    verifier_commands: [],
    required_verifiers: [],
    missing_verifiers: [],
    unsafe_tool_attempts: [],
    unrelated_changes_detected: null,
    decision_reasons: [],
    evidence_paths: {},
    report_path: join(runDir, 'BABEL_RUN_REPORT.md'),
    ...overrides,
  };
}

test('buildLearningFailureRecord classifies failed verifier evidence as TESTS_FAILED', () => {
  const runDir = makeRunDir('failed-tests');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'FAILED',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_HALTED',
      steps_executed: 2,
      tool_call_log: [
        { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test -- auth', exit_code: 1, verified: false },
      ],
    }),
    'utf-8',
  );

  const record = buildLearningFailureRecord({
    runDir,
    learningRoot,
    proof: buildProofStatus(runDir),
  });

  assert.equal(record.failure_type, 'TESTS_FAILED');
  assert.equal(record.is_failure, true);
  assert.equal(record.severity, 'high');
  assert.equal(record.lesson_candidate_recommended, true);
  assert.equal(record.candidate_fix_type, 'verifier_contract');
});

test('writeLearningFailureRecord writes learning/failures artifact', () => {
  const runDir = makeRunDir('missing-tests');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'COMPLETE',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_COMPLETE',
      steps_executed: 1,
      tool_call_log: [{ tool: 'file_write', target: 'src/auth.ts', exit_code: 0 }],
    }),
    'utf-8',
  );

  const artifacts = writeLearningFailureRecord({ runDir, learningRoot });

  assert.equal(artifacts.record.failure_type, 'CLAIMED_BUT_NOT_PROVEN');
  assert.match(artifacts.failureRecordPath, /learning-root-.+failures.+\.failure\.json/);
  assert.equal(existsSync(artifacts.failureRecordPath), true);
});

test('readLearningFailureRecord loads records by failure id and direct path', () => {
  const runDir = makeRunDir('inspect');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'FAILED',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_HALTED',
      tool_call_log: [{ tool: 'test_run', target: 'npm test -- auth', exit_code: 1 }],
    }),
    'utf-8',
  );

  const written = writeLearningFailureRecord({ runDir, learningRoot });
  const byId = readLearningFailureRecord({
    failureId: written.record.run_id,
    learningRoot,
  });
  const byPath = readLearningFailureRecord({
    failureId: written.failureRecordPath,
    learningRoot,
  });

  assert.equal(byId.record.failure_type, 'TESTS_FAILED');
  assert.equal(byPath.failureRecordPath, written.failureRecordPath);
});

test('readLearningFailureRecord rejects missing failure records', () => {
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));

  assert.throws(
    () => readLearningFailureRecord({ failureId: 'missing', learningRoot }),
    /not found/i,
  );
});

test('buildLearningFailureRecord records no failure for complete verified runs', () => {
  const runDir = makeRunDir('verified');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'COMPLETE',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_COMPLETE',
      steps_executed: 2,
      tool_call_log: [
        { tool: 'file_write', target: 'src/auth.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test -- auth', exit_code: 0, verified: true },
      ],
    }),
    'utf-8',
  );

  const record = buildLearningFailureRecord({ runDir, learningRoot });

  assert.equal(record.failure_type, 'NO_FAILURE_DETECTED');
  assert.equal(record.is_failure, false);
  assert.equal(record.severity, 'none');
  assert.equal(record.lesson_candidate_recommended, false);
});

test('buildLearningFailureRecord maps dry-run and planned-only proof to low-severity learning records', () => {
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));

  const dryRun = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'DRY_RUN_ONLY' }),
  });
  const planned = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'PLANNED_ONLY', mode: 'plan' }),
  });

  assert.equal(dryRun.failure_type, 'DRY_RUN_ONLY');
  assert.equal(dryRun.is_failure, true);
  assert.equal(dryRun.severity, 'low');
  assert.equal(planned.failure_type, 'PLANNED_ONLY');
  assert.equal(planned.is_failure, true);
  assert.equal(planned.severity, 'low');
});

test('buildLearningFailureRecord maps verifier gaps and unsafe refusals to actionable failures', () => {
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));

  const missingVerifier = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'COMPLETE_UNVERIFIED', changed_files: ['src/auth.ts'] }),
  });
  const unsafe = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({
      proof_status: 'REFUSED_UNSAFE',
      unsafe_tool_attempts: ['SHELL_COMMAND_DENIED'],
    }),
  });

  assert.equal(missingVerifier.failure_type, 'MISSING_VERIFIER_CONTRACT');
  assert.equal(missingVerifier.system_fault, true);
  assert.equal(missingVerifier.candidate_fix_type, 'verifier_contract');
  assert.equal(unsafe.failure_type, 'UNSAFE_COMMAND_ATTEMPTED');
  assert.equal(unsafe.candidate_fix_type, 'safety_policy');
});

test('buildLearningFailureRecord maps QA rejection, repair limits, and missing evidence', () => {
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));

  const qaRejected = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'STOPPED_NEEDS_HUMAN', qa_passed: false }),
  });
  const repairLimit = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'REPAIR_LIMIT_REACHED' }),
  });
  const missingEvidence = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({ proof_status: 'UNKNOWN_INSUFFICIENT_EVIDENCE' }),
  });

  assert.equal(qaRejected.failure_type, 'QA_REJECTED_PLAN');
  assert.equal(qaRejected.candidate_fix_type, 'prompt_instruction');
  assert.equal(repairLimit.failure_type, 'REPAIR_LIMIT_REACHED');
  assert.equal(missingEvidence.failure_type, 'EVIDENCE_ARTIFACT_MISSING');
  assert.equal(missingEvidence.system_fault, true);
});

test('buildLearningFailureRecord unrelated changes override complete proof', () => {
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));

  const record = buildLearningFailureRecord({
    runDir: 'unused',
    learningRoot,
    proof: proofFixture({
      proof_status: 'COMPLETE_VERIFIED',
      unrelated_changes_detected: true,
    }),
  });

  assert.equal(record.failure_type, 'UNRELATED_FILE_EDIT');
  assert.equal(record.is_failure, true);
  assert.equal(record.severity, 'high');
});

test('writeLessonCandidate creates scoped candidate artifacts from existing failure records', () => {
  const runDir = makeRunDir('lesson-candidate');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'TESTS_NOT_RUN',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      project: 'test_project',
      mode: 'deep',
      changed_files: ['src/auth.ts'],
    }),
  });

  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  const candidateArtifact = readLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.equal(candidateArtifact.lesson.lesson_id, candidate.lesson.lesson_id);
  assert.equal(candidate.lesson.failure_type, 'TYPECHECK_NOT_RUN');
  assert.equal(candidate.lesson.scope, 'project');
  assert.equal(candidate.lesson.auto_promote_allowed, false);
  assert.equal(candidate.lesson.requires_human_approval, true);
  assert.match(candidate.lesson.proposed_instruction, /TypeScript/i);
  assert.equal(existsSync(candidate.lessonCandidatePath), true);

  assert.equal(candidateArtifact.lesson.lesson_id, candidate.lesson.lesson_id);
  assert.equal(candidateArtifact.lesson.source_run_id, failure.record.run_id);
  assert.equal(candidateArtifact.lesson.failure_type, 'TYPECHECK_NOT_RUN');
  assert.equal(candidateArtifact.lesson.scope, 'project');
  assert.equal(
    candidateArtifact.lesson.proposed_instruction,
    candidate.lesson.proposed_instruction,
  );
  assert.equal(typeof candidateArtifact.lesson.risk, 'string');
  assert.equal(candidateArtifact.lesson.requires_human_approval, true);
  assert.equal(candidateArtifact.lesson.auto_promote_allowed, false);
  assert.equal(candidateArtifact.lesson.eval_requirements.length > 0, true);
  assert.equal(existsSync(candidateArtifact.lessonCandidatePath), true);
});

test('writeLessonCandidate uses project scope when known and local scope when project is unknown', () => {
  const runDir = makeRunDir('lesson-candidate-scope');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      project: 'test_project',
      tests_run: true,
      tests_passed: false,
    }),
  });

  const localScopeCandidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });

  const noProjectFailure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      project: null,
      tests_run: true,
      tests_passed: false,
    }),
  });

  const nullScopeCandidate = writeLessonCandidate({
    failureId: noProjectFailure.record.run_id,
    learningRoot,
  });

  assert.equal(localScopeCandidate.lesson.scope, 'project');
  assert.equal(nullScopeCandidate.lesson.scope, 'local');

  const explicitGlobalScopeCandidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
    scope: 'global',
  });
  assert.equal(explicitGlobalScopeCandidate.lesson.scope, 'global');
});

test('writeLessonCandidate reads from an existing failure record by direct path', () => {
  const runDir = makeRunDir('lesson-candidate-by-path');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.failureRecordPath,
    learningRoot,
  });

  assert.equal(candidate.lesson.failure_type, 'TESTS_FAILED');
  assert.equal(candidate.lesson.scope, 'project');
  assert.equal(existsSync(candidate.lessonCandidatePath), true);
});

test('testLessonCandidate writes static eval artifacts without changing proof status', () => {
  const runDir = makeRunDir('lesson-eval');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });

  const evaluated = testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.equal(evaluated.evalRecord.status, 'passed');
  assert.match(evaluated.evalRecordPath, /evals[\\/]generated/i);
  assert.equal(evaluated.evalRecord.before_proof_status, 'FAILED_TESTS');
  assert.equal(evaluated.evalRecord.after_expected_status, 'FAILED_TESTS');
  assert.equal(existsSync(evaluated.evalRecordPath), true);
  assert.equal(evaluated.evalRecord.decision_impact, 'Static replay keeps proof at FAILED_TESTS.');
  assert.match(readFileSync(evaluated.evalRecordPath, 'utf-8'), /after_expected_status/);
});

test('testLessonCandidate rejects replay that turns missing-evidence proof into COMPLETE_VERIFIED', () => {
  const runDir = makeRunDir('lesson-eval-regression');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'UNKNOWN_INSUFFICIENT_EVIDENCE',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
    }),
  });
  const lessonId = 'lesson-missing-proof-upgrade';
  const lessonPath = join(learningRoot, 'lessons', 'candidates', `${lessonId}.json`);
  mkdirSync(join(learningRoot, 'lessons', 'candidates'), { recursive: true });
  writeFileSync(
    lessonPath,
    JSON.stringify({
      schema_version: 1,
      artifact_type: 'babel_lesson_candidate',
      generated_at: '2026-06-04T00:00:00.000Z',
      lesson_id: lessonId,
      source_run_id: failure.record.run_id,
      source_failure_record_path: failure.record.failure_record_path,
      failure_type: 'NO_FAILURE_DETECTED',
      scope: 'local',
      proposed_instruction: 'Do not let this run auto verify without evidence.',
      risk: 'high',
      requires_human_approval: true,
      auto_promote_allowed: false,
      eval_requirements: ['no_false_completion'],
      status: 'candidate',
      lesson_candidate_path: lessonPath,
    }),
    'utf-8',
  );

  const evaluated = testLessonCandidate({
    lessonId,
    learningRoot,
  });

  assert.equal(evaluated.evalRecord.status, 'failed');
  assert.equal(evaluated.evalRecord.before_proof_status, 'UNKNOWN_INSUFFICIENT_EVIDENCE');
  assert.equal(evaluated.evalRecord.after_expected_status, 'COMPLETE_VERIFIED');
  assert.equal(
    evaluated.evalRecord.checks.find((check) => check.name === 'no_false_completion')?.pass,
    false,
  );
  assert.equal(
    evaluated.evalRecord.decision_impact,
    'Static replay regressed proof from UNKNOWN_INSUFFICIENT_EVIDENCE to COMPLETE_VERIFIED.',
  );
  assert.equal(
    readLearningArtifact({ id: evaluated.evalRecordPath, learningRoot }).artifact.kind,
    'eval',
  );
});

test('promoteLessonToShadow requires passing eval and writes advisory active lesson', () => {
  const runDir = makeRunDir('lesson-shadow');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'CLAIMED_BUT_NOT_PROVEN',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      execution_happened: true,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });

  assert.throws(
    () => promoteLessonToShadow({ lessonId: candidate.lesson.lesson_id, learningRoot }),
    /passing static eval/i,
  );

  testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });
  const promoted = promoteLessonToShadow({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.equal(promoted.lesson.status, 'shadow');
  assert.equal(existsSync(promoted.activeLessonPath), true);
  assert.match(readFileSync(promoted.activeLessonPath, 'utf-8'), /advisory_only/);
});

test('readLearningArtifact inspects failure, candidate, eval, and shadow lesson records', () => {
  const runDir = makeRunDir('lesson-inspect');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  const evalRecord = testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });
  promoteLessonToShadow({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.equal(
    readLearningArtifact({ id: failure.record.run_id, learningRoot }).artifact.kind,
    'failure',
  );
  assert.equal(
    readLearningArtifact({ id: candidate.lesson.lesson_id, learningRoot }).artifact.kind,
    'lesson',
  );
  assert.equal(
    readLearningArtifact({ id: evalRecord.evalRecordPath, learningRoot }).artifact.kind,
    'eval',
  );
});

test('lesson candidate hash is stable and eval records bind to candidate content', () => {
  const runDir = makeRunDir('lesson-hash');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  const reread = readLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });
  const evaluated = testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.equal(candidate.lesson.lesson_content_sha256, lessonContentHash(reread.lesson));
  assert.equal(evaluated.evalRecord.lesson_content_sha256, candidate.lesson.lesson_content_sha256);
  assert.equal(evaluated.evalRecord.failure_record_sha256, candidate.lesson.failure_record_sha256);
  assert.equal(evaluated.evalRecord.eval_policy_version, 'learning-eval-v1');
});

test('shadow promotion and mutation packaging reject stale evals after candidate edits', () => {
  const runDir = makeRunDir('lesson-stale-eval');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'babel-learning-repo-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });
  writeFileSync(
    candidate.lessonCandidatePath,
    JSON.stringify(
      {
        ...candidate.lesson,
        proposed_instruction: `${candidate.lesson.proposed_instruction} Edited after eval.`,
      },
      null,
      2,
    ),
    'utf-8',
  );

  assert.throws(
    () => promoteLessonToShadow({ lessonId: candidate.lesson.lesson_id, learningRoot }),
    /current lesson content/i,
  );
  assert.throws(
    () =>
      generateMutationPackage({
        lessonId: candidate.lesson.lesson_id,
        learningRoot,
        target: 'project-verifier-contract',
        repoRoot,
      }),
    /current lesson content/i,
  );
});

test('generateMutationPackage writes review-only package files with approval identity', () => {
  const runDir = makeRunDir('lesson-package');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'babel-learning-repo-'));
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
      project: 'test_project',
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  const pkg = generateMutationPackage({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
    target: 'project-verifier-contract',
    repoRoot,
  });

  assert.equal(pkg.mutationPackage.artifact_type, 'babel_mutation_package');
  assert.equal(pkg.mutationPackage.approval_required, true);
  assert.equal(pkg.mutationPackage.target_type, 'project-verifier-contract');
  assert.equal(
    pkg.mutationPackage.target_paths[0],
    '05_Project_Overlays/test-project/verifier-contract.md',
  );
  assert.equal(pkg.mutationPackage.rollback_available, true);
  assert.equal(pkg.mutationPackage.lesson_content_sha256, candidate.lesson.lesson_content_sha256);
  assert.equal(existsSync(pkg.mutationPackagePath), true);
  assert.equal(existsSync(pkg.proposedPatchPath), true);
  assert.equal(existsSync(pkg.selfReviewPath), true);
  assert.equal(existsSync(pkg.approvalPath), true);
  assert.equal(existsSync(pkg.rollbackPatchPath), true);
  assert.match(readFileSync(pkg.rollbackPatchPath, 'utf-8'), /Babel learning mutation package/);
  assert.equal(
    readLearningArtifact({ id: pkg.mutationPackage.mutation_id, learningRoot }).artifact.kind,
    'mutation',
  );
});

test('generateMutationPackage refuses unsupported targets and dirty target files', () => {
  const runDir = makeRunDir('lesson-package-dirty');
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-root-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'babel-learning-repo-'));
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, '05_Project_Overlays', 'test-project'), { recursive: true });
  writeFileSync(
    join(repoRoot, '05_Project_Overlays', 'test-project', 'verifier-contract.md'),
    'dirty target\n',
    'utf-8',
  );
  const failure = writeLearningFailureRecord({
    runDir,
    learningRoot,
    proof: proofFixture({
      proof_status: 'FAILED_TESTS',
      run_dir: runDir,
      run_id: runDir.split(/[\\/]/).pop() ?? 'run',
      tests_run: true,
      tests_passed: false,
      project: 'test_project',
    }),
  });
  const candidate = writeLessonCandidate({
    failureId: failure.record.run_id,
    learningRoot,
  });
  testLessonCandidate({
    lessonId: candidate.lesson.lesson_id,
    learningRoot,
  });

  assert.throws(
    () =>
      generateMutationPackage({
        lessonId: candidate.lesson.lesson_id,
        learningRoot,
        target: 'behavioral-os',
        repoRoot,
      }),
    /Unsupported learning mutation target/i,
  );
  assert.throws(
    () =>
      generateMutationPackage({
        lessonId: candidate.lesson.lesson_id,
        learningRoot,
        target: 'project-verifier-contract',
        repoRoot,
      }),
    /uncommitted changes/i,
  );
});
