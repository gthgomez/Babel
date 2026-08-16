/**
 * patchTargets.ts — shared unified-diff target extraction (P0-1 / integrity).
 *
 * ONE parser for patch target paths, consumed by BOTH:
 *   - path-jail validation (toolExecutor) — targets must stay inside scope
 *   - governance integrity checking (authority/wire.ts) — governance-path
 *     self-mutation must be denied even through apply_patch
 *
 * Pure module: no executor imports, no I/O. Ported verbatim from the
 * extraction seam that previously lived inside toolExecutor.ts.
 */

import { isAbsolute, resolve } from 'node:path';

/** Extract raw (unresolved) target paths from unified diff patch headers. */
export function extractPatchRawTargets(patchContent: string): string[] {
  const headerRe = /^[-+]{3}\s+([ab]\/)?(\S+)/gm;
  const targets = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(patchContent)) !== null) {
    const rawPath = match[2] ?? '';
    if (!rawPath || rawPath === '/dev/null') continue;
    targets.add(rawPath);
  }
  return [...targets];
}

/** Resolve raw patch targets against `projectRoot` (absolute paths). */
export function extractPatchTargets(patchContent: string, projectRoot: string): string[] {
  return extractPatchRawTargets(patchContent).map((rawPath) =>
    isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath),
  );
}
