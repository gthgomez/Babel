import * as crypto from 'crypto';
import { promises as fsPromises } from 'fs';
import { FileWriteMutex } from './editReliability.js';

export interface MutationBatchTransaction {
  batchId: string;
  sessionId?: string;
  preImages: Record<string, string | null>; // content or null if didn't exist
  postImages: Record<string, string | null>;
  preBatchHash: Record<string, string>;
  postBatchHash: Record<string, string>;
  preRevisionHash: string;
  postRevisionHash?: string;
  changedBytes: number;
  status: 'open' | 'committed' | 'rolled_back' | 'conflicted';
}

export interface MutationBatchReceipt {
  batchId: string;
  sessionId?: string;
  startingRevision: string;
  endingRevision?: string;
  affectedFiles: string[];
  preImageHashes: Record<string, string>;
  postImageHashes: Record<string, string>;
  changedBytes: number;
  status: MutationBatchTransaction['status'];
}

export class WorkspaceTransactionManager {
  private static latestBySession = new Map<string, MutationBatchTransaction>();

  static async beginBatch(paths: string[], options: { sessionId?: string } = {}): Promise<MutationBatchTransaction> {
    const preImages: Record<string, string | null> = {};
    const preBatchHash: Record<string, string> = {};

    for (const p of paths) {
      await FileWriteMutex.runExclusive(p, async () => {
        try {
          const content = await fsPromises.readFile(p, 'utf8');
          preImages[p] = content;
          preBatchHash[p] = this.hashString(content);
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            preImages[p] = null;
            preBatchHash[p] = this.hashString('');
          } else {
            throw e;
          }
        }
      });
    }

    const tx: MutationBatchTransaction = {
      batchId: crypto.randomUUID(),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      preImages,
      postImages: {},
      preBatchHash,
      postBatchHash: {},
      preRevisionHash: this.revisionHash(preBatchHash),
      changedBytes: 0,
      status: 'open',
    };
    return tx;
  }

  static async commitBatch(tx: MutationBatchTransaction): Promise<MutationBatchTransaction> {
    for (const p of Object.keys(tx.preImages)) {
      await FileWriteMutex.runExclusive(p, async () => {
        try {
          const content = await fsPromises.readFile(p, 'utf8');
          tx.postImages[p] = content;
          tx.postBatchHash[p] = this.hashString(content);
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            tx.postImages[p] = null;
            tx.postBatchHash[p] = this.hashString('');
          } else {
            throw e;
          }
        }
      });
    }
    tx.changedBytes = Object.keys(tx.preImages).reduce((total, path) => total + this.changedBytes(tx.preImages[path] ?? null, tx.postImages[path] ?? null), 0);
    tx.postRevisionHash = this.revisionHash(tx.postBatchHash);
    tx.status = 'committed';
    if (tx.sessionId) this.latestBySession.set(tx.sessionId, tx);
    return tx;
  }

  static async undoLastMutationBatch(txOrSessionId: MutationBatchTransaction | string): Promise<{ restoredPaths: string[], verification: boolean }> {
    const tx = typeof txOrSessionId === 'string' ? this.latestBySession.get(txOrSessionId) : txOrSessionId;
    if (!tx) return { restoredPaths: [], verification: false };
    const restoredPaths: string[] = [];
    let verification = true;

    for (const p of Object.keys(tx.preImages)) {
      await FileWriteMutex.runExclusive(p, async () => {
        const preImage = tx.preImages[p];
        if (preImage === null || preImage === undefined) {
          try {
            await fsPromises.unlink(p);
            restoredPaths.push(p);
          } catch (e: any) {
            if (e.code !== 'ENOENT') {
              verification = false;
            }
          }
        } else {
          await fsPromises.writeFile(p, preImage, 'utf8');
          restoredPaths.push(p);
        }

        try {
          const content = await fsPromises.readFile(p, 'utf8');
          if (this.hashString(content) !== tx.preBatchHash[p]) {
            verification = false;
          }
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            if (tx.preBatchHash[p] !== this.hashString('')) {
              verification = false;
            }
          } else {
            verification = false;
          }
        }
      });
    }

    tx.status = verification ? 'rolled_back' : 'conflicted';
    if (tx.sessionId) this.latestBySession.delete(tx.sessionId);
    return { restoredPaths, verification };
  }

  private static hashString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private static revisionHash(hashes: Record<string, string>): string {
    return this.hashString(Object.keys(hashes).sort().map((path) => `${path}:${hashes[path]}`).join('|'));
  }

  private static changedBytes(before: string | null, after: string | null): number {
    const left = Buffer.byteLength(before ?? '', 'utf8');
    const right = Buffer.byteLength(after ?? '', 'utf8');
    const common = Math.min(left, right);
    if (before === after) return 0;
    if (before === null || after === null) return Math.max(left, right);
    let changed = Math.abs(left - right);
    const maxCommon = Math.min(before.length, after.length);
    for (let index = 0; index < maxCommon; index += 1) {
      if (before.charCodeAt(index) !== after.charCodeAt(index)) changed += 1;
    }
    return changed + Math.max(0, common - maxCommon);
  }
}
