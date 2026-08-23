import * as fs from 'fs';
import { resolve } from 'node:path';

export function canonicalizeLockPath(filePath: string): string {
  const resolved = resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const LOCK_HANDLE_TOKEN = Symbol('FileLockHandleToken');

export interface FileLockHandle {
  readonly path: string;
  readonly canonicalPath: string;
  isActive(): boolean;
  holds(filePath: string): boolean;
  /** @internal */
  readonly [LOCK_HANDLE_TOKEN]?: boolean;
}

export type FileLockContext = FileLockHandle | readonly FileLockHandle[];

class ActiveFileLockHandle implements FileLockHandle {
  readonly [LOCK_HANDLE_TOKEN] = true;
  private active = true;

  constructor(
    readonly path: string,
    readonly canonicalPath: string,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  holds(filePath: string): boolean {
    if (!this.active) return false;
    return canonicalizeLockPath(filePath) === this.canonicalPath;
  }

  /** @internal */
  revoke(): void {
    this.active = false;
  }
}

function isValidHandle(handle: unknown): handle is FileLockHandle {
  if (typeof handle !== 'object' || handle === null) return false;
  return (
    (handle as Record<symbol, unknown>)[LOCK_HANDLE_TOKEN] === true &&
    typeof (handle as { isActive?: unknown }).isActive === 'function' &&
    (handle as { isActive: () => boolean }).isActive()
  );
}

function isHeldByContext(
  canonicalKey: string,
  context?: FileLockContext,
): boolean {
  if (!context) return false;
  if (Array.isArray(context)) {
    return context.some((h) => isValidHandle(h) && h.holds(canonicalKey));
  }
  return isValidHandle(context) && context.holds(canonicalKey);
}

export class FileWriteMutex {
  private static locks: Map<string, Promise<void>> = new Map();

  /**
   * Serialize work per file path. This mutex is intentionally non-reentrant.
   * Callers that already own the path lock within the current active scope
   * can pass their active `lockContext` (a `FileLockHandle` minted by `runExclusive`).
   */
  static async runExclusive<T>(
    filePath: string,
    fn: (lockHandle: FileLockHandle) => Promise<T>,
    options?: { lockContext?: FileLockContext | undefined },
  ): Promise<T> {
    const canonicalKey = canonicalizeLockPath(filePath);

    if (isHeldByContext(canonicalKey, options?.lockContext)) {
      const existingHandle = Array.isArray(options?.lockContext)
        ? options?.lockContext.find((h) => isValidHandle(h) && h.holds(canonicalKey))!
        : options?.lockContext!;
      return await fn(existingHandle);
    }

    const currentLock = this.locks.get(canonicalKey) || Promise.resolve();
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const tail = currentLock.then(() => nextLock, () => nextLock);
    this.locks.set(canonicalKey, tail);

    await currentLock.catch(() => {});
    const handle = new ActiveFileLockHandle(filePath, canonicalKey);
    try {
      return await fn(handle);
    } finally {
      handle.revoke();
      releaseLock();
      if (this.locks.get(canonicalKey) === tail) {
        this.locks.delete(canonicalKey);
      }
    }
  }

  /** Diagnostic / test helper: count of currently tracked lock keys. */
  static activeLockCount(): number {
    return this.locks.size;
  }
}

export interface NearMissContext {
  startLine: number;
  endLine: number;
  similarity: number;
  context: string;
}

export function findNearMissContext(fileContent: string, oldStr: string): NearMissContext[] {
  const fileLines = fileContent.split('\n');
  const oldLines = oldStr.split('\n');
  const L = oldLines.length;

  const candidates: NearMissContext[] = [];

  for (let windowSize = Math.max(1, L - 2); windowSize <= L + 2 && windowSize <= fileLines.length; windowSize++) {
    for (let i = 0; i <= fileLines.length - windowSize; i++) {
      const windowText = fileLines.slice(i, i + windowSize).join('\n');
      const sim = computeSimilarity(windowText, oldStr);
      if (sim > 0.7) {
        candidates.push({
          startLine: i + 1,
          endLine: i + windowSize,
          similarity: sim,
          context: windowText
        });
      }
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

export function fuzzyPatchAssist(fileContent: string, oldStr: string, newStr: string): string | null {
  const candidates = findNearMissContext(fileContent, oldStr).filter(c => c.similarity >= 0.90);

  const uniqueCandidates: NearMissContext[] = [];
  for (const c of candidates) {
    const overlaps = uniqueCandidates.some(uc =>
      !(c.endLine < uc.startLine || c.startLine > uc.endLine)
    );
    if (!overlaps) {
      uniqueCandidates.push(c);
    }
  }

  if (uniqueCandidates.length === 1) {
    const match = uniqueCandidates[0];
    if (!match) return null;
    const fileLines = fileContent.split('\n');
    const before = fileLines.slice(0, match.startLine - 1).join('\n');
    const after = fileLines.slice(match.endLine).join('\n');
    const joinerBefore = (before.length > 0 && newStr.length > 0) ? '\n' : '';
    const joinerAfter = (after.length > 0 && newStr.length > 0) ? '\n' : '';
    return (before ? before + '\n' : '') + newStr + (after ? '\n' + after : '');
  }

  return null;
}

function computeSimilarity(a: string, b: string): number {
  const aNorm = a.replace(/\s+/g, '').trim();
  const bNorm = b.replace(/\s+/g, '').trim();
  if (aNorm.length === 0 && bNorm.length === 0) return 1.0;
  if (aNorm.length === 0 || bNorm.length === 0) return 0.0;

  const maxLen = Math.max(aNorm.length, bNorm.length);
  const dist = levenshtein(aNorm, bNorm);
  return 1 - (dist / maxLen);
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  const row0 = matrix[0];
  if (row0) {
    for (let j = 0; j <= a.length; j++) {
      row0[j] = j;
    }
  }
  for (let i = 1; i <= b.length; i++) {
    const rowI = matrix[i];
    const rowIMinus1 = matrix[i - 1];
    if (rowI && rowIMinus1) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          const val = rowIMinus1[j - 1];
          if (val !== undefined) rowI[j] = val;
        } else {
          const v1 = rowIMinus1[j - 1];
          const v2 = rowI[j - 1];
          const v3 = rowIMinus1[j];
          if (v1 !== undefined && v2 !== undefined && v3 !== undefined) {
            rowI[j] = Math.min(v1 + 1, Math.min(v2 + 1, v3 + 1));
          }
        }
      }
    }
  }
  const lastRow = matrix[b.length];
  return (lastRow && lastRow[a.length]) ?? 0;
}
