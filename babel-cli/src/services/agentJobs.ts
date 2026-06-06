import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR, type ValidMode } from '../cli/constants.js';
import {
  approveApproval,
  inspectApproval,
  requestModelEscalationApproval,
  type ApprovalRecord,
} from './approvalQueue.js';
import type { CompletionVerificationGate } from './completionVerification.js';
import type { HaltDiagnosis } from './haltDiagnosis.js';
import {
  recommendModelEscalation,
  type ModelEscalationRecommendation,
} from './modelEscalationRules.js';
import { resolveApprovedWorkspacePath } from './workspaceManager.js';

export const JOB_STATUSES = [
  'queued',
  'waiting_approval',
  'running',
  'paused',
  'complete',
  'failed',
  'verification_failed',
] as const;
export type AgentJobStatus = typeof JOB_STATUSES[number];

export interface AgentJob {
  schema_version: 1;
  id: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: AgentJobStatus;
  mode: ValidMode;
  execution_profile: string;
  project_root: string | null;
  approved_roots: string[];
  model: string | null;
  model_tier: string | null;
  verify_commands: string[];
  approval_ids: string[];
  run_dir: string | null;
  pipeline_status: string | null;
  completion_verification: CompletionVerificationGate | null;
  diagnosis: HaltDiagnosis | null;
  escalation: ModelEscalationRecommendation;
  report_path: string | null;
  error: string | null;
}

export interface AgentJobRegistry {
  schema_version: 1;
  jobs: AgentJob[];
}

export interface CreateAgentJobOptions {
  id?: string;
  task: string;
  mode?: ValidMode;
  executionProfile?: string;
  projectRoot?: string | null;
  model?: string | null;
  modelTier?: string | null;
  verifyCommands?: string[];
  autoEscalate?: boolean;
  now?: Date;
}

export interface AgentJobServiceOptions {
  registryPath?: string;
}

function defaultRegistryPath(): string {
  return join(BABEL_RUNS_DIR, 'jobs', 'registry.json');
}

function resolveRegistryPath(options: AgentJobServiceOptions = {}): string {
  const explicit = process.env['BABEL_JOBS_REGISTRY_PATH']?.trim();
  return resolve(options.registryPath ?? explicit ?? defaultRegistryPath());
}

function readRegistry(path: string): AgentJobRegistry {
  if (!existsSync(path)) {
    return { schema_version: 1, jobs: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentJobRegistry>;
  return {
    schema_version: 1,
    jobs: Array.isArray(parsed.jobs)
      ? parsed.jobs.filter((job): job is AgentJob =>
          job !== null &&
          typeof job === 'object' &&
          typeof (job as AgentJob).id === 'string' &&
          typeof (job as AgentJob).task === 'string')
      : [],
  };
}

function writeRegistry(path: string, registry: AgentJobRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

function assertJobId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error('Job id must be 1-80 characters and contain only letters, numbers, underscore, or hyphen.');
  }
}

function makeJobId(date: Date): string {
  return `job-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

function normalizeVerifyCommands(commands: string[] | undefined): string[] {
  return [...new Set((commands ?? []).map(command => command.trim()).filter(Boolean))];
}

function pendingApprovalIds(job: AgentJob): string[] {
  return job.approval_ids.filter(id => inspectApproval(id)?.status === 'pending');
}

function allApprovalsGranted(job: AgentJob): boolean {
  return job.approval_ids.every(id => inspectApproval(id)?.status === 'approved');
}

export function listAgentJobs(options: AgentJobServiceOptions = {}): {
  registry_path: string;
  jobs: AgentJob[];
} {
  const registryPath = resolveRegistryPath(options);
  return {
    registry_path: registryPath,
    jobs: readRegistry(registryPath).jobs.sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
  };
}

export function getAgentJob(id: string, options: AgentJobServiceOptions = {}): AgentJob | null {
  return readRegistry(resolveRegistryPath(options)).jobs.find(job => job.id === id) ?? null;
}

export function createAgentJob(options: CreateAgentJobOptions & AgentJobServiceOptions): AgentJob {
  const task = options.task.trim();
  if (!task) {
    throw new Error('Job task is required.');
  }

  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const id = options.id?.trim() || makeJobId(nowDate);
  assertJobId(id);

  const registryPath = resolveRegistryPath(options);
  const registry = readRegistry(registryPath);
  if (registry.jobs.some(job => job.id === id)) {
    throw new Error(`Job already exists: ${id}`);
  }

  const executionProfile = options.executionProfile ?? 'opencalw_manager';
  const resolvedProject = options.projectRoot
    ? executionProfile === 'opencalw_manager'
      ? resolveApprovedWorkspacePath(options.projectRoot)
      : { path: resolve(options.projectRoot), approvedRoots: [] }
    : { path: null, approvedRoots: [] };
  const escalation = recommendModelEscalation({ task });
  const approvalIds: string[] = [];
  let modelTier = options.modelTier?.trim() || null;

  if (options.autoEscalate !== false && escalation.should_escalate && !modelTier) {
    modelTier = escalation.recommended_tier;
    const request = requestModelEscalationApproval({
      task,
      model: options.model ?? null,
      modelTier,
      projectRoot: resolvedProject.path,
    });
    approvalIds.push(request.record.id);
  }

  const job: AgentJob = {
    schema_version: 1,
    id,
    task,
    created_at: now,
    updated_at: now,
    status: approvalIds.length > 0 ? 'waiting_approval' : 'queued',
    mode: options.mode ?? 'verified',
    execution_profile: executionProfile,
    project_root: resolvedProject.path,
    approved_roots: resolvedProject.approvedRoots,
    model: options.model?.trim() || null,
    model_tier: modelTier,
    verify_commands: normalizeVerifyCommands(options.verifyCommands),
    approval_ids: approvalIds,
    run_dir: null,
    pipeline_status: null,
    completion_verification: null,
    diagnosis: null,
    escalation,
    report_path: null,
    error: null,
  };

  registry.jobs.push(job);
  writeRegistry(registryPath, registry);
  return job;
}

export function updateAgentJob(
  id: string,
  patch: Partial<Omit<AgentJob, 'schema_version' | 'id' | 'created_at'>>,
  options: AgentJobServiceOptions = {},
): AgentJob {
  const registryPath = resolveRegistryPath(options);
  const registry = readRegistry(registryPath);
  const index = registry.jobs.findIndex(job => job.id === id);
  if (index < 0) {
    throw new Error(`Job not found: ${id}`);
  }

  const updated: AgentJob = {
    ...registry.jobs[index]!,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  registry.jobs[index] = updated;
  writeRegistry(registryPath, registry);
  return updated;
}

export function pauseAgentJob(id: string, options: AgentJobServiceOptions = {}): AgentJob {
  return updateAgentJob(id, { status: 'paused' }, options);
}

export function resumeAgentJob(id: string, options: AgentJobServiceOptions = {}): AgentJob {
  const job = getAgentJob(id, options);
  if (!job) {
    throw new Error(`Job not found: ${id}`);
  }
  if (pendingApprovalIds(job).length > 0) {
    return updateAgentJob(id, { status: 'waiting_approval' }, options);
  }
  return updateAgentJob(id, { status: 'queued', error: null }, options);
}

export function approveAgentJob(id: string, options: { ttlHours?: number } & AgentJobServiceOptions = {}): {
  job: AgentJob;
  approvals: ApprovalRecord[];
} {
  const job = getAgentJob(id, options);
  if (!job) {
    throw new Error(`Job not found: ${id}`);
  }

  const approvals = job.approval_ids
    .map(approvalId => inspectApproval(approvalId))
    .filter((record): record is ApprovalRecord => record !== null)
    .map(record => record.status === 'pending'
      ? approveApproval(record.id, options.ttlHours !== undefined ? { ttlHours: options.ttlHours } : {})
      : record);
  const updated = updateAgentJob(id, {
    status: allApprovalsGranted({ ...job, approval_ids: approvals.map(record => record.id) }) ? 'queued' : 'waiting_approval',
  }, options);
  return { job: updated, approvals };
}

export function getAgentJobApprovalState(job: AgentJob): {
  pending: string[];
  approved: string[];
  denied: string[];
} {
  const records = job.approval_ids
    .map(id => inspectApproval(id))
    .filter((record): record is ApprovalRecord => record !== null);
  return {
    pending: records.filter(record => record.status === 'pending').map(record => record.id),
    approved: records.filter(record => record.status === 'approved').map(record => record.id),
    denied: records.filter(record => record.status === 'denied').map(record => record.id),
  };
}

export function writeAgentJobReport(job: AgentJob, options: AgentJobServiceOptions = {}): AgentJob {
  const registryPath = resolveRegistryPath(options);
  const reportPath = join(dirname(registryPath), 'reports', `${job.id}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ schema_version: 1, job }, null, 2)}\n`, 'utf-8');
  return updateAgentJob(job.id, { report_path: reportPath }, options);
}

export function formatAgentJobHuman(job: AgentJob): string {
  const approvalState = getAgentJobApprovalState(job);
  return [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Task: ${job.task}`,
    `Project: ${job.project_root ?? '(none)'}`,
    `Mode: ${job.mode}`,
    `Execution profile: ${job.execution_profile}`,
    `Model: ${job.model ?? '(policy default)'}`,
    `Model tier: ${job.model_tier ?? '(policy default)'}`,
    `Approvals: pending=${approvalState.pending.length}, approved=${approvalState.approved.length}, denied=${approvalState.denied.length}`,
    `Run: ${job.run_dir ?? '(not run)'}`,
    `Verification: ${job.completion_verification?.status ?? '(none)'}`,
    `Diagnosis: ${job.diagnosis?.status ?? '(none)'}`,
    ...(job.error ? [`Error: ${job.error}`] : []),
  ].join('\n');
}

export function formatAgentJobListHuman(payload: ReturnType<typeof listAgentJobs>): string {
  if (payload.jobs.length === 0) {
    return `Babel Jobs\nRegistry: ${payload.registry_path}\n\nNo jobs queued.`;
  }
  return [
    'Babel Jobs',
    `Registry: ${payload.registry_path}`,
    '',
    ...payload.jobs.map(job => `${job.id}: ${job.status} ${job.project_root ?? '(no project)'} :: ${job.task}`),
  ].join('\n');
}
