import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { hasExplicitEditDenial, isReadOnlyTaskFrame, stripFencedCodeBodies, stripScopedEditProhibitions } from '../config/chatTaskClass.js';
import { extractRequestedFileTargets } from '../stages/taskShape.js';
import { extractExactInvariants, summarizeExactInvariantFailure, verifyExactInvariants } from '../stages/exactInvariants.js';

function chatCreationRequirements(task: string): Array<{path:string;empty:boolean}> {
  if (hasExplicitEditDenial(task) || isReadOnlyTaskFrame(task)) return [];
  const prose = stripScopedEditProhibitions(stripFencedCodeBodies(task));
  const path = String.raw`[\x60"']?(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12}[\x60"']?`;
  const requests = new RegExp(String.raw`(?:^|[.!?;\r\n]|\b(?:and|then|also)\b)\s*(?:please\s+)?(?:create|write|generate|add)\s+((?:(?:a|an|the|new|empty|file|named|called)\s+)*)(${path}(?:\s*(?:,|and)\s*${path})*)`, 'gi');
  const requirements = new Map<string,{path:string;empty:boolean}>();
  for (const match of prose.matchAll(requests)) for (const target of extractRequestedFileTargets(match[2]!)) {
    requirements.set(target,{path:target,empty:requirements.get(target)?.empty === true || /\bempty\b/i.test(match[1] ?? '')});
  }
  return [...requirements.values()];
}

/** Bounded affirmative file-creation requests, independent of the model's plan. */
export function requiredChatCreatedFiles(task: string): string[] {
  return chatCreationRequirements(task).map(item=>item.path);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Verify declared creation postconditions; existing correct files are valid no-ops.
 * This is bounded artifact evidence, not a general semantic proof of arbitrary code edits.
 */
export function verifyChatCreatedOutputs(task: string, projectRoot: string): string | null {
  const requirements = chatCreationRequirements(task);
  if (requirements.length === 0) return null;
  for (const {path:target,empty} of requirements) {
    try {
      const path = resolve(projectRoot, target);
      if (!within(resolve(projectRoot), path) || !within(realpathSync(projectRoot), realpathSync(path))) {
        return `Required created output "${target}" is not a regular file inside the project.`;
      }
      const info = lstatSync(path);
      if (!info.isFile()) return `Required created output "${target}" is not a regular file.`;
      if (empty && info.size !== 0) return `Required empty output "${target}" is not empty.`;
    } catch {
      return `Required created output "${target}" is absent or cannot be independently verified.`;
    }
  }
  const normalize = (path: string): string => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
  const required = new Set(requirements.map(item=>normalize(item.path)));
  const registry = extractExactInvariants(task);
  // Reuse canonical literal checks only for outputs this creation contract owns.
  return summarizeExactInvariantFailure(verifyExactInvariants({
    projectRoot,
    registry: {schema_version:1,invariants:[],file_literal_constraints:registry.file_literal_constraints.filter(item => required.has(normalize(item.path)))},
  }));
}
