import { resolve as resolveAbsolute } from 'node:path';

import type { MemoryProvenance } from './memoryStoreLayout.js';

/** Validated when stored projectRoot resolves to the same absolute path (portable identity). */
export function provenanceMatchesProjectRoot(
  provenance: MemoryProvenance,
  absoluteProjectRoot: string,
): boolean {
  try {
    return resolveAbsolute(provenance.projectRoot) === resolveAbsolute(absoluteProjectRoot);
  } catch {
    return false;
  }
}

export function projectRootMatches(recordProjectRoot: string, absoluteProjectRoot: string): boolean {
  try {
    return resolveAbsolute(recordProjectRoot) === resolveAbsolute(absoluteProjectRoot);
  } catch {
    return false;
  }
}
