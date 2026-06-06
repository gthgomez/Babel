import { join, resolve } from 'node:path';

import { EvidenceBundle } from '../evidence.js';
import {
  createLiteArtifactRun,
  writeLiteJsonArtifact,
  writeLiteTextArtifact,
  type LiteArtifactRun,
} from '../lite/artifacts.js';
import type { LiteArtifactCommand } from '../lite/artifacts.js';
import type { BabelLiteArtifactLayout } from './contracts.js';

export interface LiteEvidenceSession {
  run: LiteArtifactRun;
  evidence: EvidenceBundle;
}

export function resolveLiteRepoRoot(projectRoot?: string): string {
  return resolve(projectRoot ?? process.cwd());
}

export function beginLiteArtifactRun(input: {
  command: LiteArtifactCommand;
  repoPath: string;
  now?: Date;
}): LiteArtifactRun {
  return createLiteArtifactRun({
    command: input.command,
    repoPath: input.repoPath,
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Repo-local `runs/babel-lite/<run-id>/` session shared by ask and fix lanes. */
export function beginLiteEvidenceSession(input: {
  command: LiteArtifactCommand;
  repoPath: string;
  now?: Date;
}): LiteEvidenceSession {
  const run = beginLiteArtifactRun(input);
  return {
    run,
    evidence: EvidenceBundle.fromExistingRun(run.runDir),
  };
}

export function writeLiteManifest(run: LiteArtifactRun, manifest: Record<string, unknown>): string {
  return writeLiteJsonArtifact(run, 'manifest.json', manifest);
}

export function writeLiteRequest(run: LiteArtifactRun, request: Record<string, unknown>): string {
  return writeLiteJsonArtifact(run, 'request.json', request);
}

export function toArtifactLayout(run: LiteArtifactRun): BabelLiteArtifactLayout {
  const files: BabelLiteArtifactLayout['files'] = {};
  for (const [name, path] of Object.entries(run.files)) {
    if (
      name === 'manifest.json' ||
      name === 'request.json' ||
      name === 'response.md' ||
      name === 'plan.md' ||
      name === 'proposal.diff' ||
      name === 'patch.diff' ||
      name === 'changes.diff' ||
      name === 'verification.json' ||
      name === 'checkpoint.json' ||
      name === 'cost_ledger.json' ||
      name === 'failure.json'
    ) {
      files[name] = path;
    }
  }
  return {
    root: 'runs/babel-lite',
    runId: run.runId,
    runDir: run.runDir,
    files,
  };
}

export function listArtifactPaths(run: LiteArtifactRun): string[] {
  return Object.values(run.files);
}

export function defaultArtifactRoot(repoPath: string): string {
  return join(resolve(repoPath), 'runs', 'babel-lite');
}
