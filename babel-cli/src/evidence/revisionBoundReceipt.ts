import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WorkspaceRevision {
  gitCommitHash: string | null;
  compositeTreeHash: string;
  fileHashes: Record<string, string>;
  capturedAt: number;
}

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

export class RevisionManager {
  static async computeRevision(projectRoot: string, touchedFiles: string[]): Promise<WorkspaceRevision> {
    const fileHashes: Record<string, string> = {};
    for (const file of touchedFiles) {
      try {
        const fullPath = path.resolve(projectRoot, file);
        const content = await fs.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        fileHashes[file] = hash;
      } catch (e) {
        fileHashes[file] = 'deleted';
      }
    }

    const keys = Object.keys(fileHashes).sort();
    const hashData = keys.map(k => `${k}:${fileHashes[k]}`).join('|');
    const compositeTreeHash = crypto.createHash('sha256').update(hashData).digest('hex');

    let gitCommitHash: string | null = null;
    try {
      gitCommitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        stdio: 'ignore',
        timeout: 10_000,
      }).toString().trim();
    } catch {
      gitCommitHash = null;
    }

    return {
      gitCommitHash,
      compositeTreeHash,
      fileHashes,
      capturedAt: Date.now()
    };
  }

  static async isReceiptStale(receipt: RevisionBoundReceipt, projectRoot: string): Promise<{stale: boolean, reason?: string}> {
    if (receipt.stale) return receipt.staleReason ? { stale: true, reason: receipt.staleReason } : { stale: true };

    const touchedFiles = Object.keys(receipt.boundRevision.fileHashes);
    const currentRevision = await this.computeRevision(projectRoot, touchedFiles);

    for (const file of touchedFiles) {
      if (receipt.boundRevision.fileHashes[file] !== currentRevision.fileHashes[file]) {
        return { stale: true, reason: `File modified after verification: ${file}` };
      }
    }

    if (receipt.boundRevision.compositeTreeHash !== currentRevision.compositeTreeHash) {
      return { stale: true, reason: 'Composite tree hash mismatch' };
    }

    if (
      receipt.boundRevision.gitCommitHash !== null &&
      currentRevision.gitCommitHash !== null &&
      receipt.boundRevision.gitCommitHash !== currentRevision.gitCommitHash
    ) {
      return { stale: true, reason: 'Git commit changed after verification' };
    }

    return { stale: false };
  }
}
