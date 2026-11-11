/**
 * Conflict-aware, exclusive memory file copy (no silent overwrite of destination bytes).
 */

import { createHash } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MemoryFileCopyOutcome =
  | { status: 'created' }
  | { status: 'identical'; contentSha256: string }
  | { status: 'conflict'; contentSha256Legacy: string; contentSha256Canonical: string }
  | { status: 'missing_source' }
  | { status: 'copy_failed'; reason: string };

export function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Copy one memory file using COPYFILE_EXCL when absent; compare digests when present.
 */
export function copyMemoryFileExclusive(
  sourceRoot: string,
  destRoot: string,
  fileName: string,
): MemoryFileCopyOutcome {
  const src = join(sourceRoot, fileName);
  const dest = join(destRoot, fileName);
  if (!existsSync(src)) return { status: 'missing_source' };
  const legacySha = sha256File(src);
  if (!legacySha) return { status: 'copy_failed', reason: 'unreadable_source' };

  if (existsSync(dest)) {
    const canonicalSha = sha256File(dest);
    if (!canonicalSha) {
      return { status: 'copy_failed', reason: 'unreadable_destination' };
    }
    if (canonicalSha === legacySha) {
      return { status: 'identical', contentSha256: canonicalSha };
    }
    return {
      status: 'conflict',
      contentSha256Legacy: legacySha,
      contentSha256Canonical: canonicalSha,
    };
  }

  try {
    mkdirSync(destRoot, { recursive: true });
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    return { status: 'created' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return copyMemoryFileExclusive(sourceRoot, destRoot, fileName);
    }
    return {
      status: 'copy_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
