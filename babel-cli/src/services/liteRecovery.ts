import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  status: 'CONTINUE_READY' | 'NO_LATEST_RUN' | 'RUN_NOT_FOUND' | 'CHAIN_COMPLETE';
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
  if (raw['artifact_type'] !== 'babel_lite_worker_chain') {
    return null;
  }
  const steps = Array.isArray(raw['steps'])
    ? raw['steps'].filter((step): step is AgentWorkerLoopStep => {
        if (step === null || typeof step !== 'object' || Array.isArray(step)) {
          return false;
        }
        const record = step as Record<string, unknown>;
        return typeof record['verb'] === 'string' && typeof record['status'] === 'string';
      })
    : [];
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
  const raw = readJson(workerChainManifestPath(sessionRunDir));
  return raw ? parseWorkerChainManifest(raw) : null;
}

function listWorkerChainManifests(projectRoot: string): WorkerChainManifest[] {
  const liteRoot = defaultArtifactRoot(projectRoot);
  if (!existsSync(liteRoot)) {
    return [];
  }
  const manifests: WorkerChainManifest[] = [];
  for (const entry of readdirSync(liteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = readWorkerChainManifest(join(liteRoot, entry.name));
    if (manifest) {
      manifests.push(manifest);
    }
  }
  return manifests.sort((left, right) => {
    const leftMtime = statSync(left.session_run_dir).mtimeMs;
    const rightMtime = statSync(right.session_run_dir).mtimeMs;
    return rightMtime - leftMtime;
  });
}

export function findLatestWorkerChainManifest(
  projectRoot: string,
  reference: string = 'latest',
): WorkerChainManifest | null {
  if (reference !== 'latest') {
    const direct = resolve(reference);
    return readWorkerChainManifest(direct) ?? readWorkerChainManifest(join(direct, '..')) ?? null;
  }
  const manifests = listWorkerChainManifests(projectRoot);
  return manifests[0] ?? null;
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
  const manifest = findLatestWorkerChainManifest(projectRoot, options.run ?? 'latest');
  if (manifest) {
    const resumeVerb = nextWorkerChainVerb(manifest);
    if (manifest.chain_status === 'complete' || resumeVerb === null) {
      return {
        status: 'CHAIN_COMPLETE',
        source: 'worker_chain',
        run_dir: manifest.session_run_dir,
        session_run_dir: manifest.session_run_dir,
        chain_status: manifest.chain_status,
        next_verb: null,
        failed_step: manifest.failed_step ?? null,
        reason: 'The linked worker chain already completed successfully.',
        next_action: 'No continuation needed.',
        next_command: null,
        manifest,
        recovery: null,
      };
    }
    const nextCommand = `bl ${resumeVerb} --project-root "${projectRoot}"`;
    return {
      status: 'CONTINUE_READY',
      source: 'worker_chain',
      run_dir: manifest.session_run_dir,
      session_run_dir: manifest.session_run_dir,
      chain_status: manifest.chain_status,
      next_verb: resumeVerb,
      failed_step: manifest.failed_step ?? null,
      reason:
        manifest.chain_status === 'failed'
          ? `Worker chain paused at ${manifest.failed_step ?? resumeVerb}; resume will retry ${resumeVerb}.`
          : `Worker chain ready for ${resumeVerb} (linked session ${manifest.session_run_id}).`,
      next_action: `Resume ${resumeVerb} from linked worker-chain manifest.`,
      next_command: nextCommand,
      manifest,
      recovery: null,
    };
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

export async function resumeLiteWorkerChain(
  options: LiteContinueOptions = {},
): Promise<AgentSessionResult | null> {
  const assessment = buildLiteContinueAssessment(options);
  if (
    assessment.source !== 'worker_chain' ||
    assessment.status !== 'CONTINUE_READY' ||
    !assessment.next_verb
  ) {
    return null;
  }
  const manifest = assessment.manifest;
  if (!manifest) {
    return null;
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
