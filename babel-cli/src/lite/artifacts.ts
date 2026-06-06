import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { redactEvidenceValue, redactSecrets } from '../utils/redaction.js';
import { LiteError } from './config.js';

export interface LiteArtifactRun {
  runId: string;
  runDir: string;
  files: Record<string, string>;
}

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'task';
}

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function shortId(): string {
  return randomBytes(4).toString('hex');
}

function assertPlainArtifactName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new LiteError('ARTIFACT_WRITE_FAILED', `Invalid Babel Lite artifact name: ${name}`);
  }
}

function normalizeFsPath(path: string): string {
  return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function assertBabelLiteArtifactRoot(root: string, repoPath: string): void {
  const expected = normalizeFsPath(join(resolve(repoPath), 'runs', 'babel-lite'));
  if (normalizeFsPath(root) !== expected) {
    throw new LiteError(
      'ARTIFACT_WRITE_FAILED',
      `Babel Lite artifacts must be written under the repo-local runs/babel-lite directory: ${root}`,
    );
  }
}

export type LiteArtifactCommand =
  | 'ask'
  | 'plan'
  | 'patch'
  | 'propose'
  | 'diff'
  | 'fix'
  | 'review'
  | 'undo'
  | 'do';

export function createLiteArtifactRun(options: {
  command: LiteArtifactCommand;
  repoPath: string;
  artifactRoot?: string;
  now?: Date;
  shortId?: string;
}): LiteArtifactRun {
  const root = resolve(options.artifactRoot ?? join(resolve(options.repoPath), 'runs', 'babel-lite'));
  assertBabelLiteArtifactRoot(root, options.repoPath);
  const runId = `${timestampSlug(options.now ?? new Date())}-${options.command}-${safeSlug(options.shortId ?? shortId())}`;
  const runDir = join(root, runId);
  try {
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
  } catch (error: unknown) {
    throw new LiteError(
      'ARTIFACT_WRITE_FAILED',
      `Failed to create Babel Lite artifact directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    runId,
    runDir,
    files: {},
  };
}

export function writeLiteTextArtifact(run: LiteArtifactRun, name: string, content: string): string {
  assertPlainArtifactName(name);
  const path = join(run.runDir, name);
  try {
    writeFileSync(path, `${redactSecrets(content).trimEnd()}\n`, 'utf-8');
  } catch (error: unknown) {
    throw new LiteError(
      'ARTIFACT_WRITE_FAILED',
      `Failed to write Babel Lite artifact "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  run.files[name] = path;
  return path;
}

export function writeLiteJsonArtifact(run: LiteArtifactRun, name: string, content: unknown): string {
  assertPlainArtifactName(name);
  const path = join(run.runDir, name);
  try {
    writeFileSync(path, `${JSON.stringify(redactEvidenceValue(content), null, 2)}\n`, 'utf-8');
  } catch (error: unknown) {
    throw new LiteError(
      'ARTIFACT_WRITE_FAILED',
      `Failed to write Babel Lite artifact "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  run.files[name] = path;
  return path;
}
