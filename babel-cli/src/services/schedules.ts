import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { runCiReview, type CiReviewReport } from './ciReview.js';
import { runGitDraft, type GitDraftKind, type GitDraftReport } from './gitDrafts.js';
import {
  createGitBranch,
  createGitCommit,
  createGitPullRequest,
  type GitMutationReport,
} from './gitMutations.js';
import { runProductBenchmark, type ProductBenchmarkReport } from './productBenchmark.js';

export type ScheduleJobType =
  | 'ci_review'
  | 'git_diff_summary'
  | 'git_commit_draft'
  | 'git_pr_draft'
  | 'benchmark_product'
  | 'git_branch_create'
  | 'git_commit_create'
  | 'git_pr_create';

export interface ScheduleDefinition {
  id: string;
  job_type: ScheduleJobType;
  created_at: string;
  updated_at: string;
  description: string | null;
  project_root: string | null;
  base_ref: string | null;
  branch_name: string | null;
  commit_message: string | null;
  pr_title: string | null;
  pr_body: string | null;
  enabled: boolean;
}

export interface ScheduleRegistry {
  schema_version: 1;
  schedules: ScheduleDefinition[];
}

export interface ScheduleRunRecord {
  schema_version: 1;
  run_type: 'schedule_run_now';
  schedule_id: string;
  job_type: ScheduleJobType;
  started_at: string;
  completed_at: string;
  status: 'ok' | 'fail';
  artifact_path: string;
  nested_artifact_path: string | null;
  result: CiReviewReport | GitDraftReport | ProductBenchmarkReport | GitMutationReport | null;
  error: string | null;
}

export interface ScheduleCreateOptions {
  id: string;
  jobType: ScheduleJobType;
  description?: string;
  projectRoot?: string;
  baseRef?: string;
  branchName?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  enabled?: boolean;
  now?: Date;
}

export interface ScheduleServiceOptions {
  registryPath?: string;
  runsRoot?: string;
  allowMutate?: boolean;
}

const JOB_TYPES: ScheduleJobType[] = [
  'ci_review',
  'git_diff_summary',
  'git_commit_draft',
  'git_pr_draft',
  'benchmark_product',
  'git_branch_create',
  'git_commit_create',
  'git_pr_create',
];

const MUTATING_JOB_TYPES = new Set<ScheduleJobType>([
  'git_branch_create',
  'git_commit_create',
  'git_pr_create',
]);

function defaultRegistryPath(): string {
  return join(BABEL_RUNS_DIR, 'schedules', 'registry.json');
}

function defaultRunsRoot(): string {
  return join(BABEL_RUNS_DIR, 'schedules', 'runs');
}

function toArtifactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function readRegistry(path: string): ScheduleRegistry {
  if (!existsSync(path)) {
    return { schema_version: 1, schedules: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScheduleRegistry>;
  const schedules = Array.isArray(parsed.schedules)
    ? parsed.schedules.filter((entry): entry is ScheduleDefinition => {
      const candidate = entry as Partial<ScheduleDefinition>;
      return typeof candidate.id === 'string' &&
        JOB_TYPES.includes(candidate.job_type as ScheduleJobType);
    })
    : [];
  return { schema_version: 1, schedules };
}

function writeRegistry(path: string, registry: ScheduleRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function assertValidScheduleId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error('Schedule id must be 1-80 characters and contain only letters, numbers, underscore, or hyphen.');
  }
}

function assertJobType(jobType: string): asserts jobType is ScheduleJobType {
  if (!JOB_TYPES.includes(jobType as ScheduleJobType)) {
    throw new Error(`Invalid schedule job type "${jobType}". Valid values: ${JOB_TYPES.join(', ')}`);
  }
}

function resolveRegistryPath(options: ScheduleServiceOptions): string {
  return resolve(options.registryPath ?? defaultRegistryPath());
}

function resolveRunsRoot(options: ScheduleServiceOptions): string {
  return resolve(options.runsRoot ?? defaultRunsRoot());
}

export function listSchedules(options: ScheduleServiceOptions = {}): {
  registry_path: string;
  schedules: ScheduleDefinition[];
} {
  const registryPath = resolveRegistryPath(options);
  return {
    registry_path: registryPath,
    schedules: readRegistry(registryPath).schedules,
  };
}

export function createSchedule(options: ScheduleCreateOptions & ScheduleServiceOptions): ScheduleDefinition {
  assertValidScheduleId(options.id);
  assertJobType(options.jobType);
  const registryPath = resolveRegistryPath(options);
  const registry = readRegistry(registryPath);
  if (registry.schedules.some((schedule) => schedule.id === options.id)) {
    throw new Error(`Schedule already exists: ${options.id}`);
  }
  const now = (options.now ?? new Date()).toISOString();
  const schedule: ScheduleDefinition = {
    id: options.id,
    job_type: options.jobType,
    created_at: now,
    updated_at: now,
    description: options.description?.trim() || null,
    project_root: options.projectRoot ? resolve(options.projectRoot) : null,
    base_ref: options.baseRef?.trim() || null,
    branch_name: options.branchName?.trim() || null,
    commit_message: options.commitMessage?.trim() || null,
    pr_title: options.prTitle?.trim() || null,
    pr_body: options.prBody?.trim() || null,
    enabled: options.enabled !== false,
  };
  registry.schedules.push(schedule);
  registry.schedules.sort((a, b) => a.id.localeCompare(b.id));
  writeRegistry(registryPath, registry);
  return schedule;
}

export function deleteSchedule(id: string, options: ScheduleServiceOptions = {}): {
  deleted: boolean;
  registry_path: string;
} {
  const registryPath = resolveRegistryPath(options);
  const registry = readRegistry(registryPath);
  const next = registry.schedules.filter((schedule) => schedule.id !== id);
  const deleted = next.length !== registry.schedules.length;
  writeRegistry(registryPath, { schema_version: 1, schedules: next });
  return { deleted, registry_path: registryPath };
}

function gitKindForJob(jobType: ScheduleJobType): GitDraftKind {
  if (jobType === 'git_diff_summary') return 'diff_summary';
  if (jobType === 'git_commit_draft') return 'commit_draft';
  return 'pr_draft';
}

function createIsolatedProjectCopy(projectRoot: string, runDir: string): string {
  const isolatedRoot = join(runDir, 'isolated-project-copy');
  const gitPath = join(projectRoot, '.git');
  if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) {
    throw new Error('Mutating scheduled jobs require a standalone Git working tree with a .git directory for safe project-copy isolation.');
  }
  const skipNames = new Set(['node_modules', 'dist', 'build', '.gradle', '.next', 'runs', 'runtime', 'babel_sandbox_runs']);
  cpSync(projectRoot, isolatedRoot, {
    recursive: true,
    force: true,
    filter(source) {
      const name = source.split(/[\\/]/).at(-1) ?? '';
      return !skipNames.has(name);
    },
  });
  return isolatedRoot;
}

function runMutatingScheduleJob(schedule: ScheduleDefinition, runDir: string, allowMutate: boolean): GitMutationReport {
  if (!allowMutate) {
    throw new Error(`Schedule job "${schedule.job_type}" is mutating and requires --allow-mutate. It will run inside an isolated project copy.`);
  }
  const sourceProjectRoot = schedule.project_root ?? process.cwd();
  const isolatedProjectRoot = createIsolatedProjectCopy(sourceProjectRoot, runDir);

  if (schedule.job_type === 'git_branch_create') {
    if (!schedule.branch_name) {
      throw new Error('git_branch_create schedules require --branch <name>.');
    }
    return createGitBranch({
      projectRoot: isolatedProjectRoot,
      outputDir: join(runDir, 'git-mutations'),
      branchName: schedule.branch_name,
      ...(schedule.base_ref ? { fromRef: schedule.base_ref } : {}),
      scheduledIsolation: 'project_copy',
    });
  }

  if (schedule.job_type === 'git_commit_create') {
    return createGitCommit({
      projectRoot: isolatedProjectRoot,
      outputDir: join(runDir, 'git-mutations'),
      ...(schedule.commit_message ? { message: schedule.commit_message } : {}),
      stageMode: 'all',
      scheduledIsolation: 'project_copy',
    });
  }

  return createGitPullRequest({
    projectRoot: isolatedProjectRoot,
    outputDir: join(runDir, 'git-mutations'),
    ...(schedule.pr_title ? { title: schedule.pr_title } : {}),
    ...(schedule.pr_body ? { body: schedule.pr_body } : {}),
    allowRemote: false,
    scheduledIsolation: 'project_copy',
  });
}

function runScheduleJob(
  schedule: ScheduleDefinition,
  runDir: string,
  allowMutate: boolean,
): CiReviewReport | GitDraftReport | ProductBenchmarkReport | GitMutationReport {
  if (MUTATING_JOB_TYPES.has(schedule.job_type)) {
    return runMutatingScheduleJob(schedule, runDir, allowMutate);
  }

  const projectRoot = schedule.project_root ?? process.cwd();
  if (schedule.job_type === 'ci_review') {
    return runCiReview({
      projectRoot,
      outputDir: join(runDir, 'ci-review'),
      ...(schedule.base_ref ? { baseRef: schedule.base_ref } : {}),
    });
  }
  if (schedule.job_type === 'benchmark_product') {
    return runProductBenchmark({
      outputDir: join(runDir, 'benchmark-product'),
    });
  }
  return runGitDraft(gitKindForJob(schedule.job_type), {
    projectRoot,
    outputDir: join(runDir, 'git-drafts'),
    ...(schedule.base_ref ? { baseRef: schedule.base_ref } : {}),
  });
}

export function runScheduleNow(id: string, options: ScheduleServiceOptions = {}): ScheduleRunRecord {
  const registryPath = resolveRegistryPath(options);
  const registry = readRegistry(registryPath);
  const schedule = registry.schedules.find((entry) => entry.id === id);
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }
  if (!schedule.enabled) {
    throw new Error(`Schedule is disabled: ${id}`);
  }
  const started = new Date();
  const runDir = join(resolveRunsRoot(options), `${id}-${toArtifactTimestamp(started)}`);
  const artifactPath = join(runDir, 'schedule-run.json');
  mkdirSync(runDir, { recursive: true });
  try {
    const result = runScheduleJob(schedule, runDir, options.allowMutate === true);
    const completedAt = new Date().toISOString();
    const nested = typeof result === 'object' && result !== null && 'artifact_path' in result
      ? String(result.artifact_path)
      : null;
    const record: ScheduleRunRecord = {
      schema_version: 1,
      run_type: 'schedule_run_now',
      schedule_id: schedule.id,
      job_type: schedule.job_type,
      started_at: started.toISOString(),
      completed_at: completedAt,
      status: 'ok',
      artifact_path: artifactPath,
      nested_artifact_path: nested,
      result,
      error: null,
    };
    writeFileSync(artifactPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  } catch (err: unknown) {
    const completedAt = new Date().toISOString();
    const record: ScheduleRunRecord = {
      schema_version: 1,
      run_type: 'schedule_run_now',
      schedule_id: schedule.id,
      job_type: schedule.job_type,
      started_at: started.toISOString(),
      completed_at: completedAt,
      status: 'fail',
      artifact_path: artifactPath,
      nested_artifact_path: null,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
    writeFileSync(artifactPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }
}

export function formatScheduleListHuman(payload: ReturnType<typeof listSchedules>): string {
  if (payload.schedules.length === 0) {
    return `Babel Schedules\nRegistry: ${payload.registry_path}\n\nNo schedules registered.`;
  }
  return [
    'Babel Schedules',
    `Registry: ${payload.registry_path}`,
    '',
    ...payload.schedules.map((schedule) => {
      const target = schedule.project_root ? ` project=${schedule.project_root}` : '';
      const base = schedule.base_ref ? ` base=${schedule.base_ref}` : '';
      return `${schedule.id}: ${schedule.job_type} (${schedule.enabled ? 'enabled' : 'disabled'})${target}${base}`;
    }),
  ].join('\n');
}

export function formatScheduleRunHuman(record: ScheduleRunRecord): string {
  return [
    'Babel Schedule Run',
    `Schedule: ${record.schedule_id}`,
    `Job: ${record.job_type}`,
    `Status: ${record.status}`,
    `Artifact: ${record.artifact_path}`,
    ...(record.nested_artifact_path ? [`Nested artifact: ${record.nested_artifact_path}`] : []),
    ...(record.error ? [`Error: ${record.error}`] : []),
  ].join('\n');
}
