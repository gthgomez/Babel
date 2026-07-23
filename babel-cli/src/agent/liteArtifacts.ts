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
      name === 'report.md' ||
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

/**
 * Lazy evidence session -- creates the run directory only when first written to.
 * In the chat fast path a successful answer never touches the filesystem.
 */
export function beginLiteEvidenceSessionLazy(options: { task: string; projectRoot?: string }): {
  getRunDir: () => string;
  writeOnError: (error: Error) => void;
  writeFinal: (result: Record<string, unknown>) => void;
} {
  let liteRun: LiteArtifactRun | null = null;

  const getOrCreateRun = (): LiteArtifactRun => {
    if (!liteRun) {
      const repoPath = resolveLiteRepoRoot(options.projectRoot);
      liteRun = createLiteArtifactRun({ command: 'ask', repoPath });
    }
    return liteRun;
  };

  return {
    getRunDir: () => getOrCreateRun().runDir,
    writeOnError: (error: Error) => {
      const run = getOrCreateRun();
      writeLiteManifest(run, { schema_version: 1, command: 'ask', task: options.task });
      writeLiteRequest(run, {
        schema_version: 1,
        command: 'ask',
        task: options.task,
      });
      writeLiteJsonArtifact(run, 'error.json', {
        message: error.message,
        stack: error.stack,
      });
    },
    writeFinal: (_result: Record<string, unknown>) => {
      // No-op for simple successful chat answers
    },
  };
}
