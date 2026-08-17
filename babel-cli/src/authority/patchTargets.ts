/**
 * patchTargets.ts — shared unified-diff target extraction (P0-1 / integrity).
 *
 * ONE parser for patch target paths, consumed by BOTH:
 *   - path-jail validation (toolExecutor) — targets must stay inside scope
 *   - governance integrity checking (authority/wire.ts) — governance-path
 *     self-mutation must be denied even through apply_patch
 *
 * Pure module: no executor imports, no I/O.
 */

import { isAbsolute, resolve } from 'node:path';

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function stripAbPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function addTarget(targets: Set<string>, raw: string): void {
  const cleaned = stripAbPrefix(unquoteGitPath(raw));
  if (!cleaned || cleaned === '/dev/null' || cleaned === 'dev/null') return;
  targets.add(cleaned);
}

/** Parse `diff --git a/foo b/bar` including quoted paths with spaces. */
function parseDiffGitPaths(line: string): string[] {
  const rest = line.slice('diff --git '.length).trim();
  const paths: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === ' ') i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      const end = rest.indexOf('"', i + 1);
      if (end === -1) {
        paths.push(rest.slice(i));
        break;
      }
      paths.push(rest.slice(i, end + 1));
      i = end + 1;
    } else {
      const end = rest.indexOf(' ', i);
      if (end === -1) {
        paths.push(rest.slice(i));
        break;
      }
      paths.push(rest.slice(i, end));
      i = end + 1;
    }
  }
  return paths;
}

/** Extract raw (unresolved) target paths from unified diff patch headers. */
export function extractPatchRawTargets(patchContent: string): string[] {
  const targets = new Set<string>();
  for (const rawLine of patchContent.split(/\r?\n/)) {
    const line = rawLine;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      let rest = line.slice(4);
      const tab = rest.indexOf('\t');
      if (tab !== -1) rest = rest.slice(0, tab);
      addTarget(targets, rest);
    } else if (
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('copy from ') ||
      line.startsWith('copy to ')
    ) {
      addTarget(targets, line.replace(/^(?:rename|copy) (?:from|to) /, ''));
    } else if (line.startsWith('diff --git ')) {
      for (const p of parseDiffGitPaths(line)) addTarget(targets, p);
    }
  }
  return [...targets];
}

/** Resolve raw patch targets against `projectRoot` (absolute paths). */
export function extractPatchTargets(patchContent: string, projectRoot: string): string[] {
  return extractPatchRawTargets(patchContent).map((rawPath) =>
    isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath),
  );
}
