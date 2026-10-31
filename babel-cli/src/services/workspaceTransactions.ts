import * as crypto from 'crypto';
import { promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileWriteMutex, type FileLockContext } from './editReliability.js';

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
  /** Host-attested creations that may be removed during compensation. */
  createdFileOwnership?: Record<string, CreatedFileOwnership>;
  /**
   * True when observed post-images matched caller-supplied expected post-images.
   * Undefined when no expectation was supplied; commitBatch alone never proves
   * the requested write happened — it only records observed bytes.
   */
  verified?: boolean;
}

export interface CreatedFileOwnership {
  device: string;
  inode: string;
  expectedContent: string;
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

async function removeOwnedCreation(path: string, ownership: CreatedFileOwnership): Promise<string | null> {
  let initial;
  try {
    initial = await fsPromises.lstat(path);
  } catch (error: any) {
    return error.code === 'ENOENT' ? null : `could not inspect created path: ${error.message}`;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.dev.toString() !== ownership.device
    || initial.ino.toString() !== ownership.inode) {
    return 'created path identity changed; current entry was preserved';
  }
  try {
    if (await fsPromises.readFile(path, 'utf8') !== ownership.expectedContent) {
      return 'created path content changed; current entry was preserved';
    }
  } catch (error: any) {
    return `could not verify created path content: ${error.message}`;
  }

  let captureDirectory: string | undefined;
  let capturePath: string | undefined;
  try {
    captureDirectory = await fsPromises.mkdtemp(join(dirname(path), '.babel-created-rollback-'));
    capturePath = join(captureDirectory, 'entry');
    await fsPromises.rename(path, capturePath);

    const captured = await fsPromises.lstat(capturePath);
    const capturedContent = await fsPromises.readFile(capturePath, 'utf8');
    const stillOwned = captured.isFile() && !captured.isSymbolicLink()
      && captured.dev.toString() === ownership.device && captured.ino.toString() === ownership.inode
      && capturedContent === ownership.expectedContent;
    if (!stillOwned) {
      try {
        await fsPromises.link(capturePath, path);
        await fsPromises.unlink(capturePath);
        try { await fsPromises.rmdir(captureDirectory); } catch { /* the preserved file remains authoritative */ }
        return 'created path changed during capture; captured entry was restored and preserved';
      } catch {
        return `created path changed during capture; entry retained at ${capturePath}`;
      }
    }

    await fsPromises.unlink(capturePath);
    try { await fsPromises.rmdir(captureDirectory); } catch { /* the created path was safely removed */ }
    try {
      await fsPromises.lstat(path);
      return 'a new entry appeared during rollback and was preserved';
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      return `could not confirm created path removal: ${error.message}`;
    }
  } catch (error: any) {
    if (capturePath) {
      try {
        await fsPromises.link(capturePath, path);
        await fsPromises.unlink(capturePath);
        if (captureDirectory) {
          try { await fsPromises.rmdir(captureDirectory); } catch { /* preserve the restored file */ }
        }
      } catch {
        // The capture is the recovery copy when exclusive restoration loses to a new entry.
      }
    } else if (captureDirectory) {
      try { await fsPromises.rmdir(captureDirectory); } catch { /* retain cleanup failure as conflict */ }
    }
    return `could not safely remove created path: ${error.message}` +
      (capturePath ? `; inspect retained capture ${capturePath}` : '');
  }
}

export class WorkspaceTransactionManager {
  private static latestBySession = new Map<string, MutationBatchTransaction>();

  static async beginBatch(
    paths: string[],
    options: { sessionId?: string; lockContext?: FileLockContext | undefined } = {},
  ): Promise<MutationBatchTransaction> {
    const preImages: Record<string, string | null> = {};
    const preBatchHash: Record<string, string> = {};

    for (const p of paths) {
      await FileWriteMutex.runExclusive(
        p,
        async () => {
          try {
            const content = await fsPromises.readFile(p, 'utf8');
            preImages[p] = content;
            preBatchHash[p] = this.hashString(content);
          } catch (e: any) {
            if (e.code === 'ENOENT') {
              preImages[p] = null;
              preBatchHash[p] = this.missingPathDigest();
            } else {
              throw e;
            }
          }
        },
        { lockContext: options.lockContext },
      );
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

  static async commitBatch(
    tx: MutationBatchTransaction,
    options: {
      lockContext?: FileLockContext | undefined;
      /**
       * Expected post-image content per path. When supplied, commitBatch
       * verifies the observed bytes actually match the requested post-image
       * and records the result in `tx.verified` (status becomes 'conflicted'
       * on mismatch). A path expected to still not exist is expressed as null.
       */
      expectedPostImages?: Record<string, string | null>;
    } = {},
  ): Promise<MutationBatchTransaction> {
    for (const p of Object.keys(tx.preImages)) {
      await FileWriteMutex.runExclusive(
        p,
        async () => {
          try {
            const content = await fsPromises.readFile(p, 'utf8');
            tx.postImages[p] = content;
            tx.postBatchHash[p] = this.hashString(content);
          } catch (e: any) {
            if (e.code === 'ENOENT') {
              tx.postImages[p] = null;
              tx.postBatchHash[p] = this.missingPathDigest();
            } else {
              throw e;
            }
          }
        },
        { lockContext: options.lockContext },
      );
    }
    tx.changedBytes = Object.keys(tx.preImages).reduce(
      (total, path) => total + this.changedBytes(tx.preImages[path] ?? null, tx.postImages[path] ?? null),
      0,
    );
    tx.postRevisionHash = this.revisionHash(tx.postBatchHash);
    if (options.expectedPostImages) {
      const expected = options.expectedPostImages;
      const expectedPaths = Object.keys(expected).sort();
      const observedPaths = Object.keys(tx.postBatchHash).sort();
      tx.verified =
        expectedPaths.length === observedPaths.length &&
        expectedPaths.every((p) => {
          const expectedHash =
            expected[p] === null ? this.missingPathDigest() : this.hashString(expected[p]!);
          return tx.postBatchHash[p] === expectedHash;
        });
      tx.status = tx.verified ? 'committed' : 'conflicted';
    } else {
      tx.status = 'committed';
    }
    if (tx.sessionId) this.latestBySession.set(tx.sessionId, tx);
    return tx;
  }

  static recordCreatedFileOwnership(
    tx: MutationBatchTransaction,
    path: string,
    ownership: CreatedFileOwnership,
  ): void {
    if (!(path in tx.preImages) || tx.preImages[path] !== null) {
      throw new Error('created-file ownership requires an absent transaction pre-image');
    }
    if (!ownership.device || !ownership.inode) {
      throw new Error('created-file ownership requires a supported device and inode identity');
    }
    tx.createdFileOwnership ??= {};
    tx.createdFileOwnership[path] = { ...ownership };
  }

  static async undoLastMutationBatch(
    txOrSessionId: MutationBatchTransaction | string,
    options: { lockContext?: FileLockContext | undefined } = {},
  ): Promise<{ restoredPaths: string[]; verification: boolean; conflicts: string[] }> {
    const tx = typeof txOrSessionId === 'string' ? this.latestBySession.get(txOrSessionId) : txOrSessionId;
    if (!tx) return { restoredPaths: [], verification: false, conflicts: [] };
    const restoredPaths: string[] = [];
    const conflicts: string[] = [];
    let verification = true;

    for (const p of Object.keys(tx.preImages)) {
      await FileWriteMutex.runExclusive(
        p,
        async () => {
          const preImage = tx.preImages[p];
          if (preImage === null || preImage === undefined) {
            const ownership = tx.createdFileOwnership?.[p];
            if (!ownership) {
              try {
                await fsPromises.lstat(p);
                conflicts.push(`${p}: no trusted creation identity; current entry was preserved`);
                verification = false;
              } catch (error: any) {
                if (error.code !== 'ENOENT') {
                  conflicts.push(`${p}: could not inspect absent pre-image path: ${error.message}`);
                  verification = false;
                }
              }
              return;
            }
            const conflict = await removeOwnedCreation(p, ownership);
            if (conflict) {
              conflicts.push(`${p}: ${conflict}`);
              verification = false;
              return;
            }
            restoredPaths.push(p);
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
              if (tx.preBatchHash[p] !== this.missingPathDigest()) {
                verification = false;
              }
            } else {
              verification = false;
            }
          }
        },
        { lockContext: options.lockContext },
      );
    }

    tx.status = verification ? 'rolled_back' : 'conflicted';
    if (tx.sessionId) this.latestBySession.delete(tx.sessionId);
    return { restoredPaths, verification, conflicts };
  }

  private static hashString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Digest recorded for a path that does NOT exist. Deliberately distinct
   * from hashString(''): an absent file and an existing empty file are
   * different workspace states, and collapsing them let a requested
   * empty-file creation "succeed" without any file landing.
   */
  static missingPathDigest(): string {
    return crypto
      .createHash('sha256')
      .update('babel://workspace-transactions/missing-path/v1')
      .digest('hex');
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
