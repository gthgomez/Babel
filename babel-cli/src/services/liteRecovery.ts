import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AgentSession } from '../agent/session.js';
import type {
  AgentSessionResult,
  AgentWorkerLoopStep,
  LiteSessionVerb,
} from '../agent/contracts.js';
import { defaultArtifactRoot } from '../agent/liteArtifacts.js';
import { buildRecoveryAssessment, type RecoveryAssessment } from './recovery.js';

export const WORKER_CHAIN_VERBS: readonly LiteSessionVerb[] = ['plan', 'propose', 'fix'];

export interface WorkerChainManifest {
  schema_version: 1;
  artifact_type: 'babel_lite_worker_chain';
  session_run_id: string;
  session_run_dir: string;
  task: string;
  project: string | null;
  project_root: string;
  provider?: string;
  chain_status: 'in_progress' | 'complete' | 'failed';
  steps: AgentWorkerLoopStep[];
  next_verb: LiteSessionVerb | null;
  failed_step?: LiteSessionVerb;
  updated_at: string;
}

export interface LiteContinueAssessment {
  status: 'CONTINUE_READY' | 'CONTINUE_BLOCKED' | 'NO_LATEST_RUN' | 'RUN_NOT_FOUND' | 'CHAIN_COMPLETE';
  source: 'worker_chain' | 'babel_run';
  run_dir: string | null;
  session_run_dir: string | null;
  chain_status: WorkerChainManifest['chain_status'] | null;
  next_verb: LiteSessionVerb | null;
  failed_step: LiteSessionVerb | null;
  reason: string;
  next_action: string;
  next_command: string | null;
  manifest: WorkerChainManifest | null;
  recovery: RecoveryAssessment | null;
}

export interface LiteContinueOptions {
  run?: string;
  project?: string;
  projectRoot?: string;
  provider?: string;
  json?: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isLiteSessionVerb(value: string): value is LiteSessionVerb {
  return (WORKER_CHAIN_VERBS as readonly string[]).includes(value);
}

export function parseWorkerChainManifest(raw: Record<string, unknown>): WorkerChainManifest | null {
  if (raw['schema_version'] !== 1 || raw['artifact_type'] !== 'babel_lite_worker_chain') {
    return null;
  }
  if (!Array.isArray(raw['steps'])) return null;
  const steps = raw['steps'];
  if (!steps.every((step): step is AgentWorkerLoopStep => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) return false;
    const record = step as Record<string, unknown>;
    return typeof record['verb'] === 'string' && isLiteSessionVerb(record['verb']) &&
      typeof record['status'] === 'string' && typeof record['exit_code'] === 'number' && Number.isInteger(record['exit_code']) &&
      (record['execution_mode'] === undefined || typeof record['execution_mode'] === 'string') &&
      (record['run_dir'] === undefined || record['run_dir'] === null || typeof record['run_dir'] === 'string');
  })) return null;
  if (raw['next_verb'] !== null && (typeof raw['next_verb'] !== 'string' || !isLiteSessionVerb(raw['next_verb']))) return null;
  if (raw['failed_step'] !== undefined && (typeof raw['failed_step'] !== 'string' || !isLiteSessionVerb(raw['failed_step']))) return null;
  const nextVerb =
    typeof raw['next_verb'] === 'string' && isLiteSessionVerb(raw['next_verb'])
      ? raw['next_verb']
      : null;
  const failedStep =
    typeof raw['failed_step'] === 'string' && isLiteSessionVerb(raw['failed_step'])
      ? raw['failed_step']
      : undefined;
  const chainStatus = raw['chain_status'];
  if (chainStatus !== 'in_progress' && chainStatus !== 'complete' && chainStatus !== 'failed') {
    return null;
  }
  if (chainStatus === 'complete' && (nextVerb !== null || failedStep !== undefined)) return null;
  if (
    typeof raw['session_run_id'] !== 'string' ||
    typeof raw['session_run_dir'] !== 'string' ||
    typeof raw['task'] !== 'string' ||
    typeof raw['project_root'] !== 'string'
  ) {
    return null;
  }
  return {
    schema_version: 1,
    artifact_type: 'babel_lite_worker_chain',
    session_run_id: raw['session_run_id'],
    session_run_dir: raw['session_run_dir'],
    task: raw['task'],
    project: typeof raw['project'] === 'string' ? raw['project'] : null,
    project_root: raw['project_root'],
    ...(typeof raw['provider'] === 'string' ? { provider: raw['provider'] } : {}),
    chain_status: chainStatus,
    steps,
    next_verb: nextVerb,
    ...(failedStep !== undefined ? { failed_step: failedStep } : {}),
    updated_at:
      typeof raw['updated_at'] === 'string' ? raw['updated_at'] : new Date().toISOString(),
  };
}

export function workerChainManifestPath(sessionRunDir: string): string {
  return join(sessionRunDir, 'worker_chain_manifest.json');
}

export function writeWorkerChainManifest(
  sessionRunDir: string,
  manifest: WorkerChainManifest,
): string {
  const path = workerChainManifestPath(sessionRunDir);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return path;
}

export function readWorkerChainManifest(sessionRunDir: string): WorkerChainManifest | null {
  try {
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    const source = resolve(sessionRunDir);
    const physical = realpathSync(source);
    if (normalize(physical) !== normalize(source)) return null;
    const path = workerChainManifestPath(physical);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || normalize(realpathSync(path)) !== normalize(path)) return null;
    const raw = readJson(path);
    const manifest = raw ? parseWorkerChainManifest(raw) : null;
    if (!manifest || normalize(resolve(manifest.session_run_dir)) !== normalize(source) || normalize(realpathSync(manifest.session_run_dir)) !== normalize(physical)) return null;
    return manifest;
  } catch { return null; }
}

function latestWorkerChainSource(projectRoot: string): string | null {
  const liteRoot = defaultArtifactRoot(projectRoot);
  if (!existsSync(liteRoot)) return null;
  const sources: Array<{ path: string; mtime: number }> = [];
  for (const entry of readdirSync(liteRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      const path = join(liteRoot, entry.name);
      let mtime = Number.POSITIVE_INFINITY;
      try { mtime = lstatSync(path).mtimeMs; } catch { /* Treat uninspectable entries as unsafe. */ }
      sources.push({ path, mtime });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const path = join(liteRoot, entry.name);
    try {
      lstatSync(workerChainManifestPath(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
    }
    let mtime = Number.POSITIVE_INFINITY;
    try { mtime = statSync(path).mtimeMs; } catch { /* Uninspectable candidates fail closed. */ }
    sources.push({ path, mtime });
  }
  return sources.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))[0]?.path ?? null;
}

function hasManifestOrUninspectable(source: string): boolean {
  try {
    const stat = lstatSync(source);
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    if (stat.isSymbolicLink() || normalize(realpathSync(source)) !== normalize(resolve(source))) return true;
    lstatSync(workerChainManifestPath(source));
    return true;
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

export function findLatestWorkerChainManifest(
  projectRoot: string,
  reference: string = 'latest',
): WorkerChainManifest | null {
  if (reference !== 'latest') {
    const direct = resolve(reference);
    const source = hasManifestOrUninspectable(direct) ? direct : resolve(direct, '..');
    return readWorkerChainManifest(source);
  }
  const source = latestWorkerChainSource(projectRoot);
  return source ? readWorkerChainManifest(source) : null;
}

export function nextWorkerChainVerb(manifest: WorkerChainManifest): LiteSessionVerb | null {
  if (manifest.chain_status === 'complete' || manifest.next_verb === null) {
    return null;
  }
  if (manifest.chain_status === 'failed' && manifest.failed_step) {
    return manifest.failed_step;
  }
  return manifest.next_verb;
}

export function buildLiteContinueAssessment(
  options: LiteContinueOptions = {},
): LiteContinueAssessment {
  const projectRoot = resolve(
    options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
  );
  const reference = options.run ?? 'latest';
  const latestSource = reference === 'latest' ? latestWorkerChainSource(projectRoot) : null;
  const manifest = reference === 'latest'
    ? (latestSource ? readWorkerChainManifest(latestSource) : null)
    : findLatestWorkerChainManifest(projectRoot, reference);
  if (manifest) {
    let sameProject = false;
    try {
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
      sameProject = normalize(realpathSync(projectRoot)) === normalize(realpathSync(manifest.project_root));
    } catch { /* Missing or uninspectable project identity fails closed. */ }
    if (!sameProject) {
      return {
        status: 'CONTINUE_BLOCKED', source: 'worker_chain', run_dir: manifest.session_run_dir,
        session_run_dir: manifest.session_run_dir, chain_status: null, next_verb: null, failed_step: null,
        reason: 'The retained worker-chain project identity does not match the selected project.',
        next_action: 'Inspect the retained artifact and select its original project.', next_command: null,
        manifest: null, recovery: null,
      };
    }
    const resumeVerb = nextWorkerChainVerb(manifest);
    if (manifest.chain_status === 'complete') {
      return {
        status: 'CHAIN_COMPLETE',
        source: 'worker_chain',
        run_dir: manifest.session_run_dir,
        session_run_dir: manifest.session_run_dir,
        chain_status: manifest.chain_status,
        next_verb: null,
        failed_step: manifest.failed_step ?? null,
        reason: 'The linked worker-chain manifest reports completion; inspect its retained evidence.',
        next_action: 'Inspect the retained worker-chain evidence.',
        next_command: null,
        manifest,
        recovery: null,
      };
    }
    return {
      status: 'CONTINUE_BLOCKED',
      source: 'worker_chain',
      run_dir: manifest.session_run_dir,
      session_run_dir: manifest.session_run_dir,
      chain_status: manifest.chain_status,
      next_verb: resumeVerb,
      failed_step: manifest.failed_step ?? null,
      reason: resumeVerb === null
        ? 'Worker chain is incomplete and has no valid next step; inspect the retained evidence.'
        : `Worker-chain action resume is temporarily unavailable until step identity and settlement are qualified; retained step: ${resumeVerb}.`,
      next_action: 'Inspect the retained worker-chain evidence.',
      next_command: null,
      manifest,
      recovery: null,
    };
  }

  if (latestSource || (options.run && options.run !== 'latest')) {
    const direct = latestSource ?? resolve(options.run!);
    const source = latestSource !== null || hasManifestOrUninspectable(direct) ? direct : resolve(direct, '..');
    const presentOrUninspectable = latestSource !== null || hasManifestOrUninspectable(source);
    if (presentOrUninspectable) {
      return {
        status: 'CONTINUE_BLOCKED', source: 'worker_chain', run_dir: source, session_run_dir: source,
        chain_status: null, next_verb: null, failed_step: null,
        reason: 'The retained worker-chain manifest is invalid or unsafe to read.',
        next_action: 'Inspect the retained artifact before continuing.', next_command: null,
        manifest: null, recovery: null,
      };
    }
  }

  const recovery = buildRecoveryAssessment({
    run: options.run ?? 'latest',
    ...(options.project !== undefined ? { project: options.project } : {}),
  });
  return {
    status:
      recovery.status === 'CONTINUE_READY' && recovery.classification === null
        ? 'CHAIN_COMPLETE'
        : recovery.status,
    source: 'babel_run',
    run_dir: recovery.run_dir,
    session_run_dir: null,
    chain_status: null,
    next_verb: null,
    failed_step: null,
    reason: recovery.reason,
    next_action: recovery.next_action,
    next_command: recovery.next_command,
    manifest: null,
    recovery,
  };
}

export function formatLiteContinueAssessmentHuman(assessment: LiteContinueAssessment): string {
  const lines = [
    'Babel Lite Continue',
    `Status: ${assessment.status}`,
    `Source: ${assessment.source}`,
  ];
  if (assessment.session_run_dir) {
    lines.push(`Session: ${assessment.session_run_dir}`);
  } else if (assessment.run_dir) {
    lines.push(`Run: ${assessment.run_dir}`);
  }
  if (assessment.next_verb) {
    lines.push(`Next verb: ${assessment.next_verb}`);
  }
  if (assessment.chain_status) {
    lines.push(`Chain: ${assessment.chain_status}`);
  }
  lines.push(`Reason: ${assessment.reason}`);
  lines.push(`Next: ${assessment.next_action}`);
  if (assessment.next_command) {
    lines.push(`Command: ${assessment.next_command}`);
  }
  return lines.join('\n');
}

/** Temporary admission fence; removal requires qualified worker recovery. */
function workerChainResumeQualified(): boolean {
  return false;
}

export async function resumeLiteWorkerChain(
  options: LiteContinueOptions = {},
): Promise<AgentSessionResult | null> {
  const assessment = buildLiteContinueAssessment(options);
  if (
    assessment.source !== 'worker_chain' ||
    assessment.status !== 'CONTINUE_BLOCKED' ||
    !assessment.next_verb
  ) {
    return null;
  }
  const manifest = assessment.manifest;
  if (!manifest) {
    return null;
  }

  // The legacy manifest does not prove the previous worker settled or bind a
  // resumed step to its original authority. Retain it for inspection until
  // worker-chain recovery has those guarantees.
  if (!workerChainResumeQualified()) {
    return {
      payload: {
        status: 'CONTINUE_BLOCKED',
        continue_source: 'worker_chain',
        run_dir: manifest.session_run_dir,
        session_run_dir: manifest.session_run_dir,
        reason: 'Worker-chain action resume is temporarily unavailable until step identity and settlement are qualified.',
      },
      exitCode: 1,
      humanText: 'Worker-chain action resume is temporarily unavailable; inspect the retained chain with continue --inspect-only.',
    };
  }

  const session = new AgentSession({
    task: manifest.task,
    verb: assessment.next_verb,
    ...(manifest.project !== null ? { project: manifest.project } : {}),
    projectRoot: manifest.project_root,
    ...(manifest.provider !== undefined ? { provider: manifest.provider as 'live' | 'mock' } : {}),
    ...(options.provider !== undefined ? { provider: options.provider as 'live' | 'mock' } : {}),
    json: options.json === true,
  });
  const result = await session.run();
  const step = {
    verb: assessment.next_verb,
    status: typeof result.payload['status'] === 'string' ? result.payload['status'] : 'UNKNOWN',
    exit_code: result.exitCode,
    ...(typeof result.payload['execution_mode'] === 'string'
      ? { execution_mode: result.payload['execution_mode'] }
      : {}),
    run_dir: typeof result.payload['run_dir'] === 'string' ? result.payload['run_dir'] : null,
  } satisfies AgentWorkerLoopStep;

  const priorSteps = manifest.steps.filter((existing) => existing.verb !== assessment.next_verb);
  const updatedSteps = [...priorSteps, step];
  const failed = result.exitCode !== 0;
  const nextIndex = WORKER_CHAIN_VERBS.indexOf(assessment.next_verb) + 1;
  const nextVerb = failed
    ? assessment.next_verb
    : nextIndex < WORKER_CHAIN_VERBS.length
      ? (WORKER_CHAIN_VERBS[nextIndex] ?? null)
      : null;
  const updatedManifest: WorkerChainManifest = {
    ...manifest,
    chain_status: failed ? 'failed' : nextVerb === null ? 'complete' : 'in_progress',
    steps: updatedSteps,
    next_verb: failed ? assessment.next_verb : nextVerb,
    ...(failed ? { failed_step: assessment.next_verb } : {}),
    updated_at: new Date().toISOString(),
  };
  if (!failed && updatedManifest.failed_step !== undefined) {
    delete updatedManifest.failed_step;
  }
  writeWorkerChainManifest(manifest.session_run_dir, updatedManifest);

  const payload: Record<string, unknown> = {
    ...result.payload,
    continue_source: 'worker_chain',
    session_run_dir: manifest.session_run_dir,
    resumed_verb: assessment.next_verb,
    worker_chain: updatedManifest,
  };
  return {
    payload,
    exitCode: result.exitCode,
    humanText: [
      `Babel Lite continue resumed ${assessment.next_verb}`,
      `Session: ${manifest.session_run_dir}`,
      `Status: ${String(payload['status'] ?? 'UNKNOWN')}`,
      failed
        ? `Worker chain failed at ${assessment.next_verb}; retry with bl continue latest.`
        : updatedManifest.chain_status === 'complete'
          ? 'Worker chain complete.'
          : `Next: bl continue latest (will run ${updatedManifest.next_verb}).`,
    ].join('\n'),
  };
}
