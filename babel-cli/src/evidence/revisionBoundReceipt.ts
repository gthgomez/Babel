import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export interface WorkspaceRevision {
  gitCommitHash: string | null;
  compositeTreeHash: string;
  fileHashes: Record<string, string>;
  capturedAt: number;
}

/** Strict runtime schema for the revision portion of canonical V1.1 receipts. */
export const WorkspaceRevisionSchema = z
  .object({
    gitCommitHash: z.string().regex(/^[a-f0-9]{40}$/i).nullable(),
    compositeTreeHash: z.string().regex(/^[a-f0-9]{64}$/i),
    fileHashes: z.record(
      z.string().min(1),
      z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.literal('deleted')]),
    ),
    capturedAt: z.number().int().finite().nonnegative(),
  })
  .strict();

export interface RevisionBoundReceipt {
  receiptId: string;
  command: string;
  exitCode: number;
  boundRevision: WorkspaceRevision;
  stale: boolean;
  authority?: boolean;
  authoritySource?: string;
  staleReason?: string;
}

/** Strict runtime schema for canonical V1.1 verifier receipt evidence. */
export const VerifierReceiptEvidenceV1Schema = z
  .object({
    schema_version: z.literal(1),
    receipt: z
      .object({
        receiptId: z.string().trim().min(1),
        command: z.string().trim().min(1),
        exitCode: z.number().int(),
        boundRevision: WorkspaceRevisionSchema,
        stale: z.boolean(),
        staleReason: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type VerifierReceiptEvidenceV1 = z.infer<
  typeof VerifierReceiptEvidenceV1Schema
>;

function hashFileContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function compositeFromFileHashes(fileHashes: Record<string, string>): string {
  const keys = Object.keys(fileHashes).sort();
  const hashData = keys.map((k) => `${k}:${fileHashes[k]}`).join('|');
  return crypto.createHash('sha256').update(hashData).digest('hex');
}

function readGitHead(projectRoot: string): string | null {
  try {
    // Must capture stdout — stdio:'ignore' made gitCommitHash always null (H7 binding dead).
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    });
    const trimmed = String(head).trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function compareRevisions(
  bound: WorkspaceRevision,
  current: WorkspaceRevision,
): { stale: boolean; reason?: string } {
  for (const file of Object.keys(bound.fileHashes)) {
    if (bound.fileHashes[file] !== current.fileHashes[file]) {
      return { stale: true, reason: `File modified after verification: ${file}` };
    }
  }
  if (bound.compositeTreeHash !== current.compositeTreeHash) {
    return { stale: true, reason: 'Composite tree hash mismatch' };
  }
  if (bound.gitCommitHash !== current.gitCommitHash) {
    return { stale: true, reason: 'Git commit changed after verification' };
  }
  return { stale: false };
}

export class RevisionManager {
  /** Synchronous revision capture for Chat finalize (streamDone/buildResult are sync). */
  static computeRevisionSync(projectRoot: string, touchedFiles: string[]): WorkspaceRevision {
    const fileHashes: Record<string, string> = {};
    for (const file of touchedFiles) {
      try {
        const fullPath = path.resolve(projectRoot, file);
        const content = fs.readFileSync(fullPath);
        fileHashes[file] = hashFileContent(content);
      } catch {
        fileHashes[file] = 'deleted';
      }
    }
    return {
      gitCommitHash: readGitHead(projectRoot),
      compositeTreeHash: compositeFromFileHashes(fileHashes),
      fileHashes,
      capturedAt: Date.now(),
    };
  }

  static async computeRevision(
    projectRoot: string,
    touchedFiles: string[],
  ): Promise<WorkspaceRevision> {
    const fileHashes: Record<string, string> = {};
    for (const file of touchedFiles) {
      try {
        const fullPath = path.resolve(projectRoot, file);
        const content = await fsp.readFile(fullPath);
        fileHashes[file] = hashFileContent(content);
      } catch {
        fileHashes[file] = 'deleted';
      }
    }
    return {
      gitCommitHash: readGitHead(projectRoot),
      compositeTreeHash: compositeFromFileHashes(fileHashes),
      fileHashes,
      capturedAt: Date.now(),
    };
  }

  static isReceiptStaleSync(
    receipt: RevisionBoundReceipt,
    projectRoot: string,
  ): { stale: boolean; reason?: string } {
    if (receipt.stale) {
      return receipt.staleReason
        ? { stale: true, reason: receipt.staleReason }
        : { stale: true };
    }
    const touchedFiles = Object.keys(receipt.boundRevision.fileHashes);
    const currentRevision = this.computeRevisionSync(projectRoot, touchedFiles);
    return compareRevisions(receipt.boundRevision, currentRevision);
  }

  static async isReceiptStale(
    receipt: RevisionBoundReceipt,
    projectRoot: string,
  ): Promise<{ stale: boolean; reason?: string }> {
    if (receipt.stale) {
      return receipt.staleReason
        ? { stale: true, reason: receipt.staleReason }
        : { stale: true };
    }
    const touchedFiles = Object.keys(receipt.boundRevision.fileHashes);
    const currentRevision = await this.computeRevision(projectRoot, touchedFiles);
    return compareRevisions(receipt.boundRevision, currentRevision);
  }
}
