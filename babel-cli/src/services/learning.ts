import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

import {
  buildProofStatus,
  type ProofStatus,
  type ProofStatusArtifact,
} from './proof.js';

export type LearningFailureType =
  | 'NO_FAILURE_DETECTED'
  | 'CLAIMED_BUT_NOT_EXECUTED'
  | 'CLAIMED_BUT_NOT_PROVEN'
  | 'TESTS_NOT_RUN'
  | 'TESTS_FAILED'
  | 'TYPECHECK_NOT_RUN'
  | 'UNRELATED_FILE_EDIT'
  | 'UNSAFE_COMMAND_ATTEMPTED'
  | 'DEPENDENCY_INSTALL_NEEDS_APPROVAL'
  | 'DIRTY_TREE_RISK'
  | 'PROMPT_CONFLICT'
  | 'STALE_DOC_CLAIM'
  | 'WRONG_MODE_SELECTED'
  | 'MISSING_PROJECT_CONTEXT'
  | 'MISSING_VERIFIER_CONTRACT'
  | 'QA_REJECTED_PLAN'
  | 'REPAIR_LIMIT_REACHED'
  | 'EVIDENCE_ARTIFACT_MISSING'
  | 'UNKNOWN_INSUFFICIENT_EVIDENCE'
  | 'DRY_RUN_ONLY'
  | 'PLANNED_ONLY'
  | 'NEEDS_HUMAN_APPROVAL';

export type LearningSeverity = 'none' | 'low' | 'medium' | 'high';
export type LessonRisk = 'low' | 'medium' | 'high';
export type LessonScope = 'project' | 'local' | 'global';
export type LessonCandidateStatus = 'candidate' | 'shadow';
export type LessonEvalStatus = 'passed' | 'failed';
export type LearningMutationTarget = 'project-verifier-contract' | 'project-overlay';

export const LESSON_EVAL_POLICY_VERSION = 'learning-eval-v1';
export const MUTATION_PACKAGE_POLICY_VERSION = 'learning-mutation-package-v1';

export interface LearningFailureRecord {
  schema_version: 1;
  artifact_type: 'babel_learning_failure';
  generated_at: string;
  run_id: string;
  run_dir: string;
  proof_status: ProofStatus;
  failure_type: LearningFailureType;
  is_failure: boolean;
  severity: LearningSeverity;
  agent_fault: boolean;
  system_fault: boolean;
  instruction_gap: boolean;
  lesson_candidate_recommended: boolean;
  task: string | null;
  project: string | null;
  mode: string | null;
  claimed_status: string | null;
  observed_status: string | null;
  root_cause_summary: string;
  recommended_next_step: string;
  candidate_fix_type: 'none' | 'verifier_contract' | 'safety_policy' | 'mode_routing' | 'project_context' | 'prompt_instruction' | 'evidence_collection';
  observed_evidence: {
    execution_happened: boolean;
    qa_passed: boolean | null;
    tests_run: boolean;
    tests_passed: boolean | null;
    changed_files: string[];
    commands_run: string[];
    verifier_commands: string[];
    required_verifiers: string[];
    missing_verifiers: string[];
    unsafe_tool_attempts: string[];
    unrelated_changes_detected: boolean | null;
    decision_reasons: string[];
  };
  evidence_paths: Record<string, string>;
  proof_status_path: string | null;
  failure_record_path: string;
}

export interface LearningFailureArtifacts {
  record: LearningFailureRecord;
  failureRecordPath: string;
}

export interface ReadLearningFailureResult {
  record: LearningFailureRecord;
  failureRecordPath: string;
}

export interface LearningLessonCandidate {
  schema_version: 1;
  artifact_type: 'babel_lesson_candidate';
  generated_at: string;
  lesson_id: string;
  source_run_id: string;
  source_failure_record_path: string;
  failure_type: LearningFailureType;
  scope: LessonScope;
  proposed_instruction: string;
  risk: LessonRisk;
  requires_human_approval: boolean;
  auto_promote_allowed: boolean;
  eval_requirements: string[];
  lesson_content_sha256: string;
  failure_record_sha256: string;
  status: LessonCandidateStatus;
  lesson_candidate_path: string;
}

export interface LessonCandidateArtifacts {
  lesson: LearningLessonCandidate;
  lessonCandidatePath: string;
}

export interface LessonEvalRecord {
  schema_version: 1;
  artifact_type: 'babel_lesson_eval';
  generated_at: string;
  eval_id: string;
  lesson_id: string;
  lesson_path: string;
  lesson_content_sha256: string;
  failure_record_sha256: string;
  eval_policy_version: typeof LESSON_EVAL_POLICY_VERSION;
  source_failure_record_path: string;
  status: LessonEvalStatus;
  before_proof_status: ProofStatus;
  after_expected_status: ProofStatus;
  decision_impact: string;
  checks: Array<{
    name: string;
    pass: boolean;
    note: string;
  }>;
  eval_record_path: string;
}

export interface LessonEvalArtifacts {
  evalRecord: LessonEvalRecord;
  evalRecordPath: string;
}

export interface ShadowLessonArtifacts {
  lesson: LearningLessonCandidate;
  activeLessonPath: string;
}

export interface LearningMutationPackageRecord {
  schema_version: 1;
  artifact_type: 'babel_mutation_package';
  generated_at: string;
  mutation_id: string;
  mutation_package_path: string;
  lesson_id: string;
  lesson_content_sha256: string;
  failure_record_sha256: string;
  eval_id: string;
  eval_record_path: string;
  eval_policy_version: typeof LESSON_EVAL_POLICY_VERSION;
  package_policy_version: typeof MUTATION_PACKAGE_POLICY_VERSION;
  target_type: LearningMutationTarget;
  target_paths: string[];
  risk: LessonRisk;
  scope: LessonScope;
  approval_required: true;
  approval_identity_sha256: string;
  promotion_level: 'package_review';
  blocked_if_dirty_targets: true;
  rollback_available: true;
  validation_commands: string[];
  reviewer_checklist: string[];
  files: {
    mutation_json: string;
    proposed_patch: string;
    self_review_md: string;
    approval_md: string;
    rollback_patch: string;
  };
  package_content_sha256: string;
}

export interface LearningMutationPackageArtifacts {
  mutationPackage: LearningMutationPackageRecord;
  mutationPackageDir: string;
  mutationPackagePath: string;
  proposedPatchPath: string;
  selfReviewPath: string;
  approvalPath: string;
  rollbackPatchPath: string;
}

export type LearningInspectArtifact =
  | { kind: 'failure'; record: LearningFailureRecord; path: string }
  | { kind: 'lesson'; record: LearningLessonCandidate; path: string }
  | { kind: 'eval'; record: LessonEvalRecord; path: string }
  | { kind: 'mutation'; record: LearningMutationPackageRecord; path: string };

export interface ReadLearningArtifactResult {
  artifact: LearningInspectArtifact;
}

interface LessonCandidateBuildInput {
  failure: LearningFailureRecord;
  learningRoot: string;
  scope?: LessonScope;
}

interface LessonCandidateWriteInput {
  failureId: string;
  learningRoot: string;
  scope?: LessonScope;
}

interface GenerateMutationPackageInput {
  lessonId: string;
  learningRoot: string;
  target: string;
  repoRoot: string;
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function lessonHashPayload(record: LearningLessonCandidate): Record<string, unknown> {
  return withoutUndefined({
    schema_version: record.schema_version,
    artifact_type: record.artifact_type,
    lesson_id: record.lesson_id,
    source_run_id: record.source_run_id,
    source_failure_record_path: record.source_failure_record_path,
    failure_type: record.failure_type,
    scope: record.scope,
    proposed_instruction: record.proposed_instruction,
    risk: record.risk,
    requires_human_approval: record.requires_human_approval,
    auto_promote_allowed: record.auto_promote_allowed,
    eval_requirements: record.eval_requirements,
  });
}

function failureHashPayload(record: LearningFailureRecord): Record<string, unknown> {
  return withoutUndefined({
    schema_version: record.schema_version,
    artifact_type: record.artifact_type,
    run_id: record.run_id,
    run_dir: record.run_dir,
    proof_status: record.proof_status,
    failure_type: record.failure_type,
    is_failure: record.is_failure,
    severity: record.severity,
    agent_fault: record.agent_fault,
    system_fault: record.system_fault,
    instruction_gap: record.instruction_gap,
    lesson_candidate_recommended: record.lesson_candidate_recommended,
    task: record.task,
    project: record.project,
    mode: record.mode,
    claimed_status: record.claimed_status,
    observed_status: record.observed_status,
    root_cause_summary: record.root_cause_summary,
    recommended_next_step: record.recommended_next_step,
    candidate_fix_type: record.candidate_fix_type,
    observed_evidence: record.observed_evidence,
    evidence_paths: record.evidence_paths,
    proof_status_path: record.proof_status_path,
  });
}

export function lessonContentHash(record: LearningLessonCandidate): string {
  return sha256(stableJson(lessonHashPayload(record)));
}

export function failureRecordHash(record: LearningFailureRecord): string {
  return sha256(stableJson(failureHashPayload(record)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readExistingProof(runDir: string): ProofStatusArtifact | null {
  const proof = asRecord(readJson(join(runDir, 'proof_status.json')));
  return proof.artifact_type === 'babel_proof_status' ? proof as unknown as ProofStatusArtifact : null;
}

function resolveFailureRecordPath(input: { failureId: string; learningRoot: string }): string {
  const trimmed = input.failureId.trim();
  if (!trimmed) {
    throw new Error('failure-id must be non-empty.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return trimmed;
  }
  const filename = trimmed.endsWith('.failure.json') ? trimmed : `${trimmed}.failure.json`;
  return join(input.learningRoot, 'failures', filename);
}

function resolveLessonCandidatePath(input: { lessonId: string; learningRoot: string }): string {
  const trimmed = input.lessonId.trim();
  if (!trimmed) {
    throw new Error('lesson-id must be non-empty.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return trimmed;
  }
  const filename = trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`;
  return join(input.learningRoot, 'lessons', 'candidates', filename);
}

function resolveActiveLessonPath(input: { lessonId: string; learningRoot: string }): string {
  const trimmed = input.lessonId.trim();
  if (!trimmed) {
    throw new Error('lesson-id must be non-empty.');
  }
  const filename = trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`;
  return join(input.learningRoot, 'lessons', 'active', filename);
}

function resolveMutationPackagePath(input: { mutationId: string; learningRoot: string }): string {
  const trimmed = input.mutationId.trim();
  if (!trimmed) {
    throw new Error('mutation-id must be non-empty.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return trimmed;
  }
  return join(input.learningRoot, 'mutations', trimmed, 'mutation.json');
}

function slugPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : 'lesson';
}

function lessonIdForFailure(record: LearningFailureRecord): string {
  return `lesson_${slugPart(record.run_id)}_${slugPart(record.failure_type)}`;
}

function evalIdForLesson(lessonId: string): string {
  return `${slugPart(lessonId)}_eval_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17)}`;
}

function mutationIdForLesson(lessonId: string, lessonHash: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const nonce = randomUUID().replace(/-/g, '').slice(0, 8);
  return `mutation_${slugPart(lessonId)}_${lessonHash.slice(0, 12)}_${timestamp}_${nonce}`;
}

function assertMutationTarget(value: string): asserts value is LearningMutationTarget {
  if (value !== 'project-verifier-contract' && value !== 'project-overlay') {
    throw new Error(`Unsupported learning mutation target "${value}". Supported targets: project-verifier-contract, project-overlay.`);
  }
}

function projectSegmentForFailure(failure: LearningFailureRecord): string {
  return slugPart(failure.project ?? failure.run_id);
}

function targetPathsForMutation(input: {
  target: LearningMutationTarget;
  failure: LearningFailureRecord;
}): string[] {
  const projectSegment = projectSegmentForFailure(input.failure);
  if (input.target === 'project-verifier-contract') {
    return [`05_Project_Overlays/${projectSegment}/verifier-contract.md`];
  }
  return [`05_Project_Overlays/${projectSegment}/PROJECT_CONTEXT.md`];
}

function assertSafeLearningRelativePath(path: string): void {
  const normalized = normalize(path).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`Unsafe learning mutation path: ${path}`);
  }
}

function isGitDirtyTarget(repoRoot: string, relativePath: string): boolean {
  const target = resolve(repoRoot, relativePath);
  if (!target.startsWith(resolve(repoRoot))) {
    throw new Error(`Mutation target escapes repo root: ${relativePath}`);
  }
  if (!existsSync(target)) {
    return false;
  }
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', relativePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    throw new Error(`Cannot verify dirty target state for ${relativePath}.`);
  }
}

function patchLines(content: string): string[] {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.length === 0 ? [] : normalized.split('\n');
}

function buildProposedMutationContent(input: {
  lesson: LearningLessonCandidate;
  evalRecord: LessonEvalRecord;
  target: LearningMutationTarget;
}): string {
  return [
    '<!-- Babel learning mutation package: review-only -->',
    `<!-- lesson_id: ${input.lesson.lesson_id} -->`,
    `<!-- lesson_content_sha256: ${input.lesson.lesson_content_sha256} -->`,
    `<!-- eval_id: ${input.evalRecord.eval_id} -->`,
    '',
    `Babel advisory lesson (${input.target}): ${input.lesson.proposed_instruction}`,
    '',
  ].join('\n');
}

function buildAppendPatch(input: {
  relativePath: string;
  existingContent: string | null;
  appendContent: string;
}): string {
  const appendLines = patchLines(input.appendContent);
  const existingLines = input.existingContent === null ? [] : patchLines(input.existingContent);
  const header = input.existingContent === null
    ? [
        `diff --git a/${input.relativePath} b/${input.relativePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${input.relativePath}`,
        `@@ -0,0 +1,${appendLines.length} @@`,
      ]
    : [
        `diff --git a/${input.relativePath} b/${input.relativePath}`,
        `--- a/${input.relativePath}`,
        `+++ b/${input.relativePath}`,
        `@@ -${existingLines.length},0 +${existingLines.length + 1},${appendLines.length} @@`,
      ];
  return `${[...header, ...appendLines.map(line => `+${line}`)].join('\n')}\n`;
}

function buildRollbackPatch(input: {
  relativePath: string;
  existingContent: string | null;
  appendContent: string;
}): string {
  const appendLines = patchLines(input.appendContent);
  const existingLines = input.existingContent === null ? [] : patchLines(input.existingContent);
  const header = input.existingContent === null
    ? [
        `diff --git a/${input.relativePath} b/${input.relativePath}`,
        'deleted file mode 100644',
        `--- a/${input.relativePath}`,
        '+++ /dev/null',
        `@@ -1,${appendLines.length} +0,0 @@`,
      ]
    : [
        `diff --git a/${input.relativePath} b/${input.relativePath}`,
        `--- a/${input.relativePath}`,
        `+++ b/${input.relativePath}`,
        `@@ -${existingLines.length + 1},${appendLines.length} +${existingLines.length},0 @@`,
      ];
  return `${[...header, ...appendLines.map(line => `-${line}`)].join('\n')}\n`;
}

function riskForFailure(record: LearningFailureRecord): LessonRisk {
  if (record.failure_type === 'UNSAFE_COMMAND_ATTEMPTED' || record.failure_type === 'UNRELATED_FILE_EDIT') {
    return 'high';
  }
  if (record.severity === 'low') {
    return 'low';
  }
  if (record.severity === 'none') {
    return 'low';
  }
  return record.severity === 'high' ? 'medium' : record.severity;
}

function evalRequirementsForFailure(record: LearningFailureRecord): string[] {
  const requirements = ['no_false_completion', 'no_safety_policy_regression'];
  if (record.candidate_fix_type === 'verifier_contract' || record.failure_type === 'TYPECHECK_NOT_RUN') {
    requirements.push('verifier_contract_preserved');
  }
  if (record.candidate_fix_type === 'evidence_collection') {
    requirements.push('evidence_paths_preserved');
  }
  if (record.candidate_fix_type === 'safety_policy') {
    requirements.push('unsafe_refusal_preserved');
  }
  return requirements;
}

function proposedInstructionForFailure(record: LearningFailureRecord): string {
  switch (record.failure_type) {
    case 'NO_FAILURE_DETECTED':
      return 'No lesson should be promoted from a complete verified run.';
    case 'TESTS_FAILED':
      return 'When a verifier or test command fails, keep the run unverified and carry the failing command into the next repair plan.';
    case 'TYPECHECK_NOT_RUN':
      return 'When TypeScript source files change, require typecheck or a targeted verifier before any COMPLETE_VERIFIED status.';
    case 'TESTS_NOT_RUN':
    case 'MISSING_VERIFIER_CONTRACT':
      return 'When files change, require a scoped verifier contract before marking the run COMPLETE_VERIFIED.';
    case 'CLAIMED_BUT_NOT_EXECUTED':
    case 'CLAIMED_BUT_NOT_PROVEN':
      return 'Block completion claims unless execution and verifier evidence support the claimed final status.';
    case 'UNRELATED_FILE_EDIT':
      return 'Before completion, reject runs that include unrelated changed files outside the requested task scope.';
    case 'UNSAFE_COMMAND_ATTEMPTED':
      return 'Preserve unsafe-tool refusals as blocking evidence and do not retry with broader permissions automatically.';
    case 'QA_REJECTED_PLAN':
      return 'When QA rejects a plan, require replanning from the rejection reasons before execution can proceed.';
    case 'REPAIR_LIMIT_REACHED':
      return 'When repair limits are reached, stop and surface the repeated failure evidence instead of continuing mutation attempts.';
    case 'EVIDENCE_ARTIFACT_MISSING':
    case 'UNKNOWN_INSUFFICIENT_EVIDENCE':
      return 'Treat missing or inconsistent run artifacts as insufficient proof and request evidence repair before completion.';
    default:
      return record.recommended_next_step;
  }
}

function readLessonCandidatePath(path: string): LearningLessonCandidate {
  const record = asRecord(readJson(path));
  if (!existsSync(path)) {
    throw new Error(`Learning lesson candidate not found: ${path}`);
  }
  if (record.artifact_type !== 'babel_lesson_candidate') {
    throw new Error(`File is not a Babel lesson candidate: ${path}`);
  }
  return record as unknown as LearningLessonCandidate;
}

function resolveCandidateScope(input: {
  failure: LearningFailureRecord;
  scope?: LessonScope;
}): LessonScope {
  if (input.scope === undefined) {
    return input.failure.project ? 'project' : 'local';
  }
  return input.scope;
}

function findLatestPassingEval(input: {
  lessonId: string;
  learningRoot: string;
  lessonContentSha256: string;
}): LessonEvalRecord | null {
  const evalRoot = join(input.learningRoot, 'evals', 'generated');
  if (!existsSync(evalRoot)) {
    return null;
  }
  const candidates = readdirSync(evalRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(evalRoot, name))
    .map((path) => asRecord(readJson(path)))
    .filter((record) => record.artifact_type === 'babel_lesson_eval')
    .filter((record) => record.lesson_id === input.lessonId)
    .map((record) => record as unknown as LessonEvalRecord)
    .filter((record) => record.status === 'passed')
    .filter((record) => record.eval_policy_version === LESSON_EVAL_POLICY_VERSION)
    .filter((record) => record.lesson_content_sha256 === input.lessonContentSha256)
    .sort((left, right) => right.generated_at.localeCompare(left.generated_at));
  return candidates[0] ?? null;
}

function proofSafetyRank(status: ProofStatus): number {
  switch (status) {
    case 'UNKNOWN_INSUFFICIENT_EVIDENCE':
      return 1;
    case 'DRY_RUN_ONLY':
    case 'PLANNED_ONLY':
      return 2;
    case 'REPAIR_LIMIT_REACHED':
    case 'NEEDS_HUMAN_APPROVAL':
    case 'STOPPED_NEEDS_HUMAN':
      return 3;
    case 'REFUSED_UNSAFE':
      return 4;
    case 'TESTS_NOT_RUN':
      return 5;
    case 'FAILED_TESTS':
      return 6;
    case 'CLAIMED_BUT_NOT_PROVEN':
      return 7;
    case 'COMPLETE_UNVERIFIED':
      return 8;
    case 'COMPLETE_VERIFIED':
      return 9;
    default:
      return 0;
  }
}

function replayLessonProofDecision(input: {
  candidate: LearningLessonCandidate;
  failure: LearningFailureRecord;
}): ProofStatus {
  if (!input.failure.is_failure) {
    return input.failure.proof_status;
  }
  if (input.candidate.failure_type === 'UNRELATED_FILE_EDIT' && input.failure.proof_status === 'COMPLETE_VERIFIED') {
    return 'CLAIMED_BUT_NOT_PROVEN';
  }
  if (input.candidate.failure_type === 'NO_FAILURE_DETECTED') {
    return 'COMPLETE_VERIFIED';
  }
  return input.failure.proof_status;
}

function formatDecisionImpact(input: {
  before: ProofStatus;
  after: ProofStatus;
  proofSafetyDidImprove: boolean;
  proofSafetyDidChange: boolean;
}): string {
  if (!input.proofSafetyDidChange) {
    return `Static replay keeps proof at ${input.before}.`;
  }
  if (input.proofSafetyDidImprove) {
    return `Static replay tightened proof from ${input.before} to ${input.after}.`;
  }
  return `Static replay regressed proof from ${input.before} to ${input.after}.`;
}

function classifyFailure(proof: ProofStatusArtifact): {
  failureType: LearningFailureType;
  severity: LearningSeverity;
  agentFault: boolean;
  systemFault: boolean;
  instructionGap: boolean;
  lessonCandidateRecommended: boolean;
  candidateFixType: LearningFailureRecord['candidate_fix_type'];
  rootCauseSummary: string;
  recommendedNextStep: string;
} {
  if (proof.unrelated_changes_detected === true) {
    return {
      failureType: 'UNRELATED_FILE_EDIT',
      severity: 'high',
      agentFault: true,
      systemFault: false,
      instructionGap: true,
      lessonCandidateRecommended: true,
      candidateFixType: 'safety_policy',
      rootCauseSummary: 'Run evidence indicates unrelated changes were detected.',
      recommendedNextStep: 'Propose a scoped safety lesson requiring unrelated-change checks before completion.',
    };
  }

  switch (proof.proof_status) {
    case 'COMPLETE_VERIFIED':
      return {
        failureType: 'NO_FAILURE_DETECTED',
        severity: 'none',
        agentFault: false,
        systemFault: false,
        instructionGap: false,
        lessonCandidateRecommended: false,
        candidateFixType: 'none',
        rootCauseSummary: 'Run has enough evidence for COMPLETE_VERIFIED.',
        recommendedNextStep: 'No learning failure record is needed beyond this audit artifact.',
      };
    case 'COMPLETE_UNVERIFIED':
      return {
        failureType: 'MISSING_VERIFIER_CONTRACT',
        severity: 'medium',
        agentFault: false,
        systemFault: true,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'verifier_contract',
        rootCauseSummary: 'Run may be complete, but passing verifier evidence is missing or not required.',
        recommendedNextStep: 'Propose a verifier contract that defines required proof before COMPLETE_VERIFIED.',
      };
    case 'CLAIMED_BUT_NOT_PROVEN':
      return {
        failureType: proof.execution_happened ? 'CLAIMED_BUT_NOT_PROVEN' : 'CLAIMED_BUT_NOT_EXECUTED',
        severity: 'high',
        agentFault: true,
        systemFault: false,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: proof.tests_run ? 'evidence_collection' : 'verifier_contract',
        rootCauseSummary: 'Agent completion claim is not supported by required execution/verifier evidence.',
        recommendedNextStep: 'Generate a lesson candidate that blocks completion claims without proof.',
      };
    case 'FAILED_TESTS':
      return {
        failureType: 'TESTS_FAILED',
        severity: 'high',
        agentFault: true,
        systemFault: false,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'verifier_contract',
        rootCauseSummary: 'A verifier or test command ran and failed.',
        recommendedNextStep: 'Generate a lesson candidate that preserves failed verifier context for repair planning.',
      };
    case 'TESTS_NOT_RUN':
      return {
        failureType: proof.changed_files.some((file) => /\.(?:ts|tsx|mts|cts)$/.test(file)) ? 'TYPECHECK_NOT_RUN' : 'TESTS_NOT_RUN',
        severity: 'high',
        agentFault: true,
        systemFault: false,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'verifier_contract',
        rootCauseSummary: 'Mutation evidence exists, but no verifier/test command was observed.',
        recommendedNextStep: 'Propose a verifier rule requiring targeted checks after source edits.',
      };
    case 'REFUSED_UNSAFE':
      return {
        failureType: proof.unsafe_tool_attempts.length > 0 ? 'UNSAFE_COMMAND_ATTEMPTED' : 'DIRTY_TREE_RISK',
        severity: 'high',
        agentFault: true,
        systemFault: false,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'safety_policy',
        rootCauseSummary: 'Safety policy refused the run or tool attempt.',
        recommendedNextStep: 'Preserve the refusal as a safety lesson candidate; do not auto-promote behavior changes.',
      };
    case 'NEEDS_HUMAN_APPROVAL':
      return {
        failureType: 'DEPENDENCY_INSTALL_NEEDS_APPROVAL',
        severity: 'medium',
        agentFault: false,
        systemFault: false,
        instructionGap: false,
        lessonCandidateRecommended: false,
        candidateFixType: 'none',
        rootCauseSummary: 'Run needs human approval before it can proceed.',
        recommendedNextStep: 'Request approval or rerun with a lower-risk plan.',
      };
    case 'STOPPED_NEEDS_HUMAN':
      return {
        failureType: proof.qa_passed === false ? 'QA_REJECTED_PLAN' : 'NEEDS_HUMAN_APPROVAL',
        severity: 'medium',
        agentFault: proof.qa_passed === false,
        systemFault: false,
        instructionGap: proof.qa_passed === false,
        lessonCandidateRecommended: proof.qa_passed === false,
        candidateFixType: proof.qa_passed === false ? 'prompt_instruction' : 'none',
        rootCauseSummary: proof.qa_passed === false ? 'QA rejected the plan or completion path.' : 'Run stopped because human input is needed.',
        recommendedNextStep: proof.qa_passed === false
          ? 'Propose a planning lesson from the QA rejection reasons.'
          : 'Resolve the human-input blocker before learning from this run.',
      };
    case 'REPAIR_LIMIT_REACHED':
      return {
        failureType: 'REPAIR_LIMIT_REACHED',
        severity: 'high',
        agentFault: true,
        systemFault: false,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'prompt_instruction',
        rootCauseSummary: 'Repair loop or evidence loop reached its configured limit.',
        recommendedNextStep: 'Propose a repair-planning lesson from repeated failure evidence.',
      };
    case 'DRY_RUN_ONLY':
      return {
        failureType: 'DRY_RUN_ONLY',
        severity: 'low',
        agentFault: false,
        systemFault: false,
        instructionGap: false,
        lessonCandidateRecommended: false,
        candidateFixType: 'none',
        rootCauseSummary: 'Run only produced dry-run or shadow evidence.',
        recommendedNextStep: 'Rerun in an approved live mode if mutation proof is required.',
      };
    case 'PLANNED_ONLY':
      return {
        failureType: 'PLANNED_ONLY',
        severity: 'low',
        agentFault: false,
        systemFault: false,
        instructionGap: false,
        lessonCandidateRecommended: false,
        candidateFixType: 'none',
        rootCauseSummary: 'Run produced planning or handoff evidence without execution.',
        recommendedNextStep: 'Resume/apply the plan if execution proof is desired.',
      };
    case 'UNKNOWN_INSUFFICIENT_EVIDENCE':
      return {
        failureType: 'EVIDENCE_ARTIFACT_MISSING',
        severity: 'medium',
        agentFault: false,
        systemFault: true,
        instructionGap: true,
        lessonCandidateRecommended: true,
        candidateFixType: 'evidence_collection',
        rootCauseSummary: 'Run artifacts are missing or insufficient for proof classification.',
        recommendedNextStep: 'Propose an evidence-collection lesson for missing proof artifacts.',
      };
  }
}

export function buildLearningFailureRecord(input: {
  runDir: string;
  learningRoot: string;
  proof?: ProofStatusArtifact;
}): LearningFailureRecord {
  const proof = input.proof ?? readExistingProof(input.runDir) ?? buildProofStatus(input.runDir);
  const classification = classifyFailure(proof);
  const failureRecordPath = join(input.learningRoot, 'failures', `${proof.run_id}.failure.json`);
  const proofStatusPath = existsSync(join(input.runDir, 'proof_status.json'))
    ? join(input.runDir, 'proof_status.json')
    : null;

  return {
    schema_version: 1,
    artifact_type: 'babel_learning_failure',
    generated_at: new Date().toISOString(),
    run_id: proof.run_id,
    run_dir: proof.run_dir,
    proof_status: proof.proof_status,
    failure_type: classification.failureType,
    is_failure: classification.failureType !== 'NO_FAILURE_DETECTED',
    severity: classification.severity,
    agent_fault: classification.agentFault,
    system_fault: classification.systemFault,
    instruction_gap: classification.instructionGap,
    lesson_candidate_recommended: classification.lessonCandidateRecommended,
    task: proof.task,
    project: proof.project,
    mode: proof.mode,
    claimed_status: proof.claimed_status,
    observed_status: proof.observed_status,
    root_cause_summary: classification.rootCauseSummary,
    recommended_next_step: classification.recommendedNextStep,
    candidate_fix_type: classification.candidateFixType,
    observed_evidence: {
      execution_happened: proof.execution_happened,
      qa_passed: proof.qa_passed,
      tests_run: proof.tests_run,
      tests_passed: proof.tests_passed,
      changed_files: proof.changed_files,
      commands_run: proof.commands_run,
      verifier_commands: proof.verifier_commands,
      required_verifiers: proof.required_verifiers,
      missing_verifiers: proof.missing_verifiers,
      unsafe_tool_attempts: proof.unsafe_tool_attempts,
      unrelated_changes_detected: proof.unrelated_changes_detected,
      decision_reasons: proof.decision_reasons,
    },
    evidence_paths: proof.evidence_paths,
    proof_status_path: proofStatusPath,
    failure_record_path: failureRecordPath,
  };
}

export function writeLearningFailureRecord(input: {
  runDir: string;
  learningRoot: string;
  proof?: ProofStatusArtifact;
}): LearningFailureArtifacts {
  const record = buildLearningFailureRecord(input);
  mkdirSync(join(input.learningRoot, 'failures'), { recursive: true });
  writeFileSync(record.failure_record_path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  return {
    record,
    failureRecordPath: record.failure_record_path,
  };
}

export function readLearningFailureRecord(input: {
  failureId: string;
  learningRoot: string;
}): ReadLearningFailureResult {
  const failureRecordPath = resolveFailureRecordPath(input);
  const record = asRecord(readJson(failureRecordPath));
  if (!existsSync(failureRecordPath)) {
    throw new Error(`Learning failure record not found: ${failureRecordPath}`);
  }
  if (record.artifact_type !== 'babel_learning_failure') {
    throw new Error(`File is not a Babel learning failure record: ${failureRecordPath}`);
  }
  return {
    record: record as unknown as LearningFailureRecord,
    failureRecordPath,
  };
}

export function buildLessonCandidate(input: LessonCandidateBuildInput): LearningLessonCandidate {
  const lessonId = lessonIdForFailure(input.failure);
  const lessonCandidatePath = join(input.learningRoot, 'lessons', 'candidates', `${lessonId}.json`);
  const risk = riskForFailure(input.failure);
  const scope = resolveCandidateScope(input);
  const candidateBase = {
    schema_version: 1,
    artifact_type: 'babel_lesson_candidate',
    generated_at: new Date().toISOString(),
    lesson_id: lessonId,
    source_run_id: input.failure.run_id,
    source_failure_record_path: input.failure.failure_record_path,
    failure_type: input.failure.failure_type,
    scope,
    proposed_instruction: proposedInstructionForFailure(input.failure),
    risk,
    requires_human_approval: risk !== 'low',
    auto_promote_allowed: false,
    eval_requirements: evalRequirementsForFailure(input.failure),
    status: 'candidate' as const,
    lesson_candidate_path: lessonCandidatePath,
  };
  const lesson = candidateBase as LearningLessonCandidate;
  lesson.failure_record_sha256 = failureRecordHash(input.failure);
  lesson.lesson_content_sha256 = lessonContentHash(lesson);
  return lesson;
}

export function writeLessonCandidate(input: LessonCandidateWriteInput): LessonCandidateArtifacts {
  const failure = readLearningFailureRecord({
    failureId: input.failureId,
    learningRoot: input.learningRoot,
  }).record;
  const lesson = buildLessonCandidate({
    failure,
    learningRoot: input.learningRoot,
    ...(input.scope ? { scope: input.scope } : {}),
  });
  mkdirSync(join(input.learningRoot, 'lessons', 'candidates'), { recursive: true });
  writeFileSync(lesson.lesson_candidate_path, `${JSON.stringify(lesson, null, 2)}\n`, 'utf-8');
  return {
    lesson,
    lessonCandidatePath: lesson.lesson_candidate_path,
  };
}

export function readLessonCandidate(input: {
  lessonId: string;
  learningRoot: string;
}): LessonCandidateArtifacts {
  const candidatePath = resolveLessonCandidatePath(input);
  const lesson = readLessonCandidatePath(candidatePath);
  return {
    lesson,
    lessonCandidatePath: candidatePath,
  };
}

export function testLessonCandidate(input: {
  lessonId: string;
  learningRoot: string;
}): LessonEvalArtifacts {
  const candidate = readLessonCandidate(input).lesson;
  const failure = readLearningFailureRecord({
    failureId: candidate.source_failure_record_path,
    learningRoot: input.learningRoot,
  }).record;
  const currentFailureHash = failureRecordHash(failure);
  const currentLessonHash = lessonContentHash(candidate);
  const evalId = evalIdForLesson(candidate.lesson_id);
  const evalRecordPath = join(input.learningRoot, 'evals', 'generated', `${evalId}.json`);
  const beforeProofStatus = failure.proof_status;
  const afterExpectedStatus = replayLessonProofDecision({
    candidate,
    failure,
  });
  const proofSafetyBefore = proofSafetyRank(beforeProofStatus);
  const proofSafetyAfter = proofSafetyRank(afterExpectedStatus);
  const safetyNotWeaker = proofSafetyAfter <= proofSafetyBefore;
  const proofSafetyDidImprove = proofSafetyAfter < proofSafetyBefore;
  const proofSafetyDidChange = proofSafetyAfter !== proofSafetyBefore;
  const checks = [
    {
      name: 'source_failure_targeted',
      pass: failure.is_failure === true && candidate.source_run_id === failure.run_id,
      note: failure.is_failure
        ? 'Lesson candidate is anchored to a failing or incomplete source run.'
        : 'Complete verified runs should not produce actionable lessons.',
    },
    {
      name: 'failure_signature_match',
      pass: candidate.failure_type === failure.failure_type,
      note: candidate.failure_type === failure.failure_type
        ? `Failure signature ${candidate.failure_type} matches source run record.`
        : `Failure signature mismatch: lesson ${candidate.failure_type} vs ${failure.failure_type}.`,
    },
    {
      name: 'no_safety_policy_regression',
      pass: candidate.auto_promote_allowed === false,
      note: candidate.auto_promote_allowed
        ? 'Candidate allows automatic promotion.'
        : 'Candidate cannot auto-promote into behavior changes.',
    },
    {
      name: 'no_false_completion',
      pass: safetyNotWeaker,
      note: safetyNotWeaker
        ? 'Static replay does not weaken the original proof safety decision.'
        : `Static replay would change ${beforeProofStatus} to ${afterExpectedStatus}, increasing completion confidence.`,
    },
  ];
  const status: LessonEvalStatus = checks.every((check) => check.pass) ? 'passed' : 'failed';
  const decisionImpact = formatDecisionImpact({
    before: beforeProofStatus,
    after: afterExpectedStatus,
    proofSafetyDidImprove,
    proofSafetyDidChange,
  });
  const evalRecord: LessonEvalRecord = {
    schema_version: 1,
    artifact_type: 'babel_lesson_eval',
    generated_at: new Date().toISOString(),
    eval_id: evalId,
    lesson_id: candidate.lesson_id,
    lesson_path: candidate.lesson_candidate_path,
    lesson_content_sha256: currentLessonHash,
    failure_record_sha256: currentFailureHash,
    eval_policy_version: LESSON_EVAL_POLICY_VERSION,
    source_failure_record_path: candidate.source_failure_record_path,
    status,
    before_proof_status: failure.proof_status,
    after_expected_status: afterExpectedStatus,
    decision_impact: status === 'passed' ? decisionImpact : decisionImpact,
    checks,
    eval_record_path: evalRecordPath,
  };
  mkdirSync(join(input.learningRoot, 'evals', 'generated'), { recursive: true });
  writeFileSync(evalRecordPath, `${JSON.stringify(evalRecord, null, 2)}\n`, 'utf-8');
  return {
    evalRecord,
    evalRecordPath,
  };
}

export function promoteLessonToShadow(input: {
  lessonId: string;
  learningRoot: string;
}): ShadowLessonArtifacts {
  const candidate = readLessonCandidate(input).lesson;
  const currentLessonHash = lessonContentHash(candidate);
  const passingEval = findLatestPassingEval({
    lessonId: candidate.lesson_id,
    learningRoot: input.learningRoot,
    lessonContentSha256: currentLessonHash,
  });
  if (!passingEval) {
    throw new Error(`Lesson ${candidate.lesson_id} needs a passing static eval for the current lesson content before shadow promotion.`);
  }
  const activeLessonPath = resolveActiveLessonPath({
    lessonId: candidate.lesson_id,
    learningRoot: input.learningRoot,
  });
  const activeLesson: LearningLessonCandidate = {
    ...candidate,
    generated_at: new Date().toISOString(),
    lesson_content_sha256: currentLessonHash,
    status: 'shadow',
    lesson_candidate_path: activeLessonPath,
  };
  mkdirSync(join(input.learningRoot, 'lessons', 'active'), { recursive: true });
  writeFileSync(activeLessonPath, `${JSON.stringify({
    ...activeLesson,
    promotion: {
      promotion_level: 'shadow',
      promoted_at: activeLesson.generated_at,
      eval_record_path: passingEval.eval_record_path,
      eval_id: passingEval.eval_id,
      lesson_content_sha256: currentLessonHash,
      advisory_only: true,
    },
  }, null, 2)}\n`, 'utf-8');
  return {
    lesson: activeLesson,
    activeLessonPath,
  };
}

export function generateMutationPackage(input: GenerateMutationPackageInput): LearningMutationPackageArtifacts {
  assertMutationTarget(input.target);
  const candidate = readLessonCandidate(input).lesson;
  const failure = readLearningFailureRecord({
    failureId: candidate.source_failure_record_path,
    learningRoot: input.learningRoot,
  }).record;
  const currentLessonHash = lessonContentHash(candidate);
  const currentFailureHash = failureRecordHash(failure);
  const passingEval = findLatestPassingEval({
    lessonId: candidate.lesson_id,
    learningRoot: input.learningRoot,
    lessonContentSha256: currentLessonHash,
  });
  if (!passingEval) {
    throw new Error(`Lesson ${candidate.lesson_id} needs a passing static eval for the current lesson content before mutation packaging.`);
  }
  if (passingEval.failure_record_sha256 !== currentFailureHash) {
    throw new Error(`Lesson ${candidate.lesson_id} eval is stale for the current failure record.`);
  }
  if (candidate.scope !== 'project') {
    throw new Error(`Learning mutation packages are project-scoped in P7; lesson ${candidate.lesson_id} has scope ${candidate.scope}.`);
  }

  const targetPaths = targetPathsForMutation({ target: input.target, failure });
  for (const targetPath of targetPaths) {
    assertSafeLearningRelativePath(targetPath);
    if (isGitDirtyTarget(input.repoRoot, targetPath)) {
      throw new Error(`Mutation target has uncommitted changes: ${targetPath}`);
    }
  }

  const targetPath = targetPaths[0]!;
  const absoluteTarget = resolve(input.repoRoot, targetPath);
  const existingContent = existsSync(absoluteTarget) ? readFileSync(absoluteTarget, 'utf-8') : null;
  const appendContent = buildProposedMutationContent({
    lesson: {
      ...candidate,
      lesson_content_sha256: currentLessonHash,
      failure_record_sha256: currentFailureHash,
    },
    evalRecord: passingEval,
    target: input.target,
  });
  const proposedPatch = buildAppendPatch({
    relativePath: targetPath,
    existingContent,
    appendContent,
  });
  const rollbackPatch = buildRollbackPatch({
    relativePath: targetPath,
    existingContent,
    appendContent,
  });
  if (rollbackPatch.trim().length === 0) {
    throw new Error(`Rollback patch is empty for mutation target: ${targetPath}`);
  }

  const mutationId = mutationIdForLesson(candidate.lesson_id, currentLessonHash);
  const mutationPackageDir = join(input.learningRoot, 'mutations', mutationId);
  const mutationPackagePath = join(mutationPackageDir, 'mutation.json');
  const proposedPatchPath = join(mutationPackageDir, 'proposed.patch');
  const selfReviewPath = join(mutationPackageDir, 'self_review.md');
  const approvalPath = join(mutationPackageDir, 'approval.md');
  const rollbackPatchPath = join(mutationPackageDir, 'rollback.patch');
  const validationCommands = [
    'npm --prefix .\\babel-cli run typecheck',
    'npm --prefix .\\babel-cli run test:proof-learning',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\tools\\validate-catalog.ps1',
  ];
  const reviewerChecklist = [
    'Confirm the mutation target is project-scoped and not a global prompt/policy surface.',
    'Confirm the lesson hash matches the passing eval hash.',
    'Confirm proposed.patch and rollback.patch are both reviewable before any apply step.',
    'Confirm validation commands are appropriate for the touched project overlay/verifier contract.',
  ];
  const selfReview = [
    '# Babel Learning Mutation Self Review',
    '',
    `Lesson: ${candidate.lesson_id}`,
    `Lesson hash: ${currentLessonHash}`,
    `Eval: ${passingEval.eval_id}`,
    `Target: ${input.target}`,
    '',
    'This package is review-only. It must not be applied automatically in P7.',
    '',
    'Safety notes:',
    ...reviewerChecklist.map(item => `- ${item}`),
    '',
  ].join('\n');
  const approval = [
    '# Babel Learning Mutation Approval',
    '',
    'Approval status: pending',
    '',
    `Mutation target: ${input.target}`,
    `Lesson: ${candidate.lesson_id}`,
    `Lesson hash: ${currentLessonHash}`,
    '',
    'Approving this package authorizes review of the proposed patch only. P7 does not apply mutations.',
    '',
  ].join('\n');

  const packageDraft = {
    schema_version: 1 as const,
    artifact_type: 'babel_mutation_package' as const,
    generated_at: new Date().toISOString(),
    mutation_id: mutationId,
    mutation_package_path: mutationPackagePath,
    lesson_id: candidate.lesson_id,
    lesson_content_sha256: currentLessonHash,
    failure_record_sha256: currentFailureHash,
    eval_id: passingEval.eval_id,
    eval_record_path: passingEval.eval_record_path,
    eval_policy_version: LESSON_EVAL_POLICY_VERSION as typeof LESSON_EVAL_POLICY_VERSION,
    package_policy_version: MUTATION_PACKAGE_POLICY_VERSION as typeof MUTATION_PACKAGE_POLICY_VERSION,
    target_type: input.target,
    target_paths: targetPaths,
    risk: candidate.risk,
    scope: candidate.scope,
    approval_required: true as const,
    promotion_level: 'package_review' as const,
    blocked_if_dirty_targets: true as const,
    rollback_available: true as const,
    validation_commands: validationCommands,
    reviewer_checklist: reviewerChecklist,
    files: {
      mutation_json: mutationPackagePath,
      proposed_patch: proposedPatchPath,
      self_review_md: selfReviewPath,
      approval_md: approvalPath,
      rollback_patch: rollbackPatchPath,
    },
  };
  const packageContentSha256 = sha256(stableJson({
    ...packageDraft,
    proposed_patch_sha256: sha256(proposedPatch),
    self_review_sha256: sha256(selfReview),
    approval_sha256: sha256(approval),
    rollback_patch_sha256: sha256(rollbackPatch),
  }));
  const mutationPackage: LearningMutationPackageRecord = {
    ...packageDraft,
    approval_identity_sha256: sha256(stableJson({
      mutation_id: mutationId,
      package_content_sha256: packageContentSha256,
      lesson_content_sha256: currentLessonHash,
      eval_id: passingEval.eval_id,
    })),
    package_content_sha256: packageContentSha256,
  };

  mkdirSync(mutationPackageDir, { recursive: true });
  writeFileSync(proposedPatchPath, proposedPatch, 'utf-8');
  writeFileSync(selfReviewPath, selfReview, 'utf-8');
  writeFileSync(approvalPath, approval, 'utf-8');
  writeFileSync(rollbackPatchPath, rollbackPatch, 'utf-8');
  writeFileSync(mutationPackagePath, `${JSON.stringify(mutationPackage, null, 2)}\n`, 'utf-8');
  return {
    mutationPackage,
    mutationPackageDir,
    mutationPackagePath,
    proposedPatchPath,
    selfReviewPath,
    approvalPath,
    rollbackPatchPath,
  };
}

export function readLearningArtifact(input: {
  id: string;
  learningRoot: string;
}): ReadLearningArtifactResult {
  const direct = input.id.includes('/') || input.id.includes('\\') ? input.id : null;
  if (direct && existsSync(direct)) {
    const record = asRecord(readJson(direct));
    if (record.artifact_type === 'babel_learning_failure') {
      return { artifact: { kind: 'failure', record: record as unknown as LearningFailureRecord, path: direct } };
    }
    if (record.artifact_type === 'babel_lesson_candidate') {
      return { artifact: { kind: 'lesson', record: record as unknown as LearningLessonCandidate, path: direct } };
    }
    if (record.artifact_type === 'babel_lesson_eval') {
      return { artifact: { kind: 'eval', record: record as unknown as LessonEvalRecord, path: direct } };
    }
    if (record.artifact_type === 'babel_mutation_package') {
      return { artifact: { kind: 'mutation', record: record as unknown as LearningMutationPackageRecord, path: direct } };
    }
  }

  const failurePath = resolveFailureRecordPath({ failureId: input.id, learningRoot: input.learningRoot });
  if (existsSync(failurePath)) {
    const result = readLearningFailureRecord({ failureId: input.id, learningRoot: input.learningRoot });
    return { artifact: { kind: 'failure', record: result.record, path: result.failureRecordPath } };
  }
  const activePath = resolveActiveLessonPath({ lessonId: input.id, learningRoot: input.learningRoot });
  if (existsSync(activePath)) {
    const lesson = readLessonCandidatePath(activePath);
    return { artifact: { kind: 'lesson', record: lesson, path: activePath } };
  }
  const mutationPath = resolveMutationPackagePath({ mutationId: input.id, learningRoot: input.learningRoot });
  if (existsSync(mutationPath)) {
    const record = asRecord(readJson(mutationPath));
    if (record.artifact_type === 'babel_mutation_package') {
      return { artifact: { kind: 'mutation', record: record as unknown as LearningMutationPackageRecord, path: mutationPath } };
    }
  }
  const candidatePath = resolveLessonCandidatePath({ lessonId: input.id, learningRoot: input.learningRoot });
  if (existsSync(candidatePath)) {
    const result = readLessonCandidate({ lessonId: input.id, learningRoot: input.learningRoot });
    return { artifact: { kind: 'lesson', record: result.lesson, path: result.lessonCandidatePath } };
  }
  throw new Error(`Learning artifact not found: ${input.id}`);
}

export function formatLearningFailureHuman(record: LearningFailureRecord): string {
  return [
    `LEARNING: ${record.failure_type}`,
    '',
    `Run: ${record.run_dir}`,
    `Proof: ${record.proof_status}`,
    `Severity: ${record.severity}`,
    `Lesson recommended: ${record.lesson_candidate_recommended ? 'yes' : 'no'}`,
    `Candidate fix: ${record.candidate_fix_type}`,
    '',
    `Root cause: ${record.root_cause_summary}`,
    `Next: ${record.recommended_next_step}`,
    '',
    `Record: ${record.failure_record_path}`,
  ].join('\n');
}

export function formatLessonCandidateHuman(record: LearningLessonCandidate): string {
  return [
    `LESSON: ${record.lesson_id}`,
    '',
    `Status: ${record.status}`,
    `Source run: ${record.source_run_id}`,
    `Failure: ${record.failure_type}`,
    `Scope: ${record.scope}`,
    `Risk: ${record.risk}`,
    `Human approval: ${record.requires_human_approval ? 'required' : 'optional'}`,
    `Auto-promote: ${record.auto_promote_allowed ? 'allowed' : 'blocked'}`,
    '',
    `Instruction: ${record.proposed_instruction}`,
    `Eval requirements: ${record.eval_requirements.join(', ')}`,
    '',
    `Record: ${record.lesson_candidate_path}`,
  ].join('\n');
}

export function formatLessonEvalHuman(record: LessonEvalRecord): string {
  return [
    `EVAL: ${record.status}`,
    '',
    `Lesson: ${record.lesson_id}`,
    `Before: ${record.before_proof_status}`,
    `After expected: ${record.after_expected_status}`,
    `Impact: ${record.decision_impact}`,
    '',
    ...record.checks.map((check) => `- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${check.note}`),
    '',
    `Record: ${record.eval_record_path}`,
  ].join('\n');
}

export function formatMutationPackageHuman(record: LearningMutationPackageRecord): string {
  return [
    `MUTATION PACKAGE: ${record.mutation_id}`,
    '',
    `Lesson: ${record.lesson_id}`,
    `Target: ${record.target_type}`,
    `Risk: ${record.risk}`,
    `Approval required: ${record.approval_required ? 'yes' : 'no'}`,
    `Lesson hash: ${record.lesson_content_sha256}`,
    `Package hash: ${record.package_content_sha256}`,
    '',
    `Targets: ${record.target_paths.join(', ')}`,
    `Validation: ${record.validation_commands.join('; ')}`,
    '',
    `Record: ${record.mutation_package_path}`,
  ].join('\n');
}
