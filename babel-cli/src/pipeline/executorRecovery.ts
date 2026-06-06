import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isVerifierCommand } from '../services/terminalStatus.js';
import { normalizeShellCommandForComparison } from './benchmarkTasks.js';


export function isVerifierNotFoundFailure(command: string, stdout: string, stderr: string): boolean {
  const commandBase = normalizeShellCommandForComparison(command).split(/\s+/)[0] ?? '';
  const evidence = `${stdout}\n${stderr}`.toLowerCase();
  return evidence.includes('missing script') ||
    evidence.includes('command not found') ||
    evidence.includes('is not recognized as an internal or external command') ||
    evidence.includes('not recognized as the name of') ||
    evidence.includes('enoent') ||
    evidence.includes('could not determine executable to run') ||
    (/npm/.test(commandBase) && /missing script:\s*["']?(?:test|typecheck|build)["']?/.test(evidence));
}

export function getAllowedToolsFromEnv(): string[] | null {
  const raw = process.env['BABEL_ALLOWED_TOOLS'];
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(value => String(value));
    }
  } catch {
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }
  return null;
}

function getDisallowedToolsFromEnv(): string[] {
  const raw = process.env['BABEL_DISALLOWED_TOOLS'];
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(value => String(value));
    }
  } catch {
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }
  return [];
}

function isFileWriteToolAvailable(): boolean {
  const allowed = getAllowedToolsFromEnv();
  return allowed === null || allowed.includes('file_write');
}

export function isShellExecutionToolAvailable(): boolean {
  const allowed = getAllowedToolsFromEnv();
  const disallowed = new Set(getDisallowedToolsFromEnv());
  return (allowed === null || allowed.includes('shell_exec')) && !disallowed.has('shell_exec');
}

export function shouldRecoverCommandFailure(command: string, rawTask: string): boolean {
  if (!isFileWriteToolAvailable()) {
    return false;
  }
  if (/\bdo not modify files\b|\binspect only\b|\bread[- ]only\b/i.test(rawTask)) {
    return false;
  }
  return isVerifierCommand(command) || /\bfix\b|\brepair\b|\bpatch\b|\bdebug\b/i.test(rawTask);
}

function extractMissingNpmScript(command: string, stdout: string, stderr: string): string | null {
  const commandBase = normalizeShellCommandForComparison(command).split(/\s+/)[0] ?? '';
  if (!/npm/.test(commandBase)) {
    return null;
  }
  const evidence = `${stdout}\n${stderr}`.toLowerCase();
  const match = evidence.match(/missing script:\s*["']?([a-z0-9:_-]+)["']?/);
  return match?.[1] ?? null;
}

function findDescendantPackageScriptCwd(
  projectRoot: string | null | undefined,
  scriptName: string,
): string | null {
  if (!projectRoot || !existsSync(projectRoot)) {
    return null;
  }

  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'runs']);
  const queue: Array<{ path: string; depth: number }> = [{ path: projectRoot, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next.depth > 3) {
      continue;
    }

    const packageJsonPath = join(next.path, 'package.json');
    if (next.path !== projectRoot && existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          scripts?: Record<string, unknown>;
        };
        if (typeof parsed.scripts?.[scriptName] === 'string') {
          return next.path;
        }
      } catch {
        // Ignore malformed nested package files; verifier retry should remain evidence-driven.
      }
    }

    let children: string[] = [];
    try {
      children = readdirSync(next.path);
    } catch {
      continue;
    }
    for (const child of children) {
      if (ignored.has(child)) {
        continue;
      }
      const childPath = join(next.path, child);
      try {
        if (statSync(childPath).isDirectory()) {
          queue.push({ path: childPath, depth: next.depth + 1 });
        }
      } catch {
        // Ignore racey or inaccessible children.
      }
    }
  }

  return null;
}

export function getNpmWrongWorkingDirectoryHint(
  command: string,
  stdout: string,
  stderr: string,
  projectRoot: string | null | undefined,
): string | null {
  const missingScript = extractMissingNpmScript(command, stdout, stderr);
  if (!missingScript) {
    return null;
  }
  const packageCwd = findDescendantPackageScriptCwd(projectRoot, missingScript);
  if (!packageCwd || !projectRoot) {
    return null;
  }
  const relativeCwd = relative(projectRoot, packageCwd).replace(/\\/g, '/');
  if (!relativeCwd || relativeCwd.startsWith('..')) {
    return null;
  }
  return `[VERIFIER_WRONG_WORKING_DIRECTORY_RETRY] npm script "${missingScript}" was not found in the current cwd, but package.json with that script exists at "${relativeCwd}". Retry the same verifier command with working_directory "${relativeCwd}".`;
}

export function inferVerifierCommandFromTask(task: string): string | null {
  const normalized = task.toLowerCase();
  if (/\bnpm\s+run\s+typecheck\b/.test(normalized)) {
    return 'npm run typecheck';
  }
  if (/\bnpm\s+run\s+build\b/.test(normalized)) {
    return 'npm run build';
  }
  if (/\bnode\s+--test\b/.test(normalized)) {
    return 'node --test';
  }
  if (/\bnpm\s+test\b/.test(normalized)) {
    return 'npm test';
  }
  return null;
}

export function inferCommandOnlyNoModificationRequest(task: string): string | null {
  const normalized = task.toLowerCase();
  if (!/\bdo not (?:modify|edit|change|write)|\bno file changes\b|\bwithout modifying\b/.test(normalized)) {
    return null;
  }
  const strippedNoModify = normalized
    .replace(/\bdo not (?:modify|edit|change|write)[^.]*\.?/g, ' ')
    .replace(/\bwithout modifying[^.]*\.?/g, ' ')
    .replace(/\bno file changes[^.]*\.?/g, ' ');
  if (/\b(fix|repair|patch|create|update|edit|modify|write|delete|remove)\b/.test(strippedNoModify)) {
    return null;
  }
  const verifierCommand = inferVerifierCommandFromTask(task);
  if (verifierCommand) {
    return verifierCommand;
  }
  const nodeMatch = task.match(/\brun\s+(node\s+[A-Za-z0-9._/\\-]+(?:\.mjs|\.cjs|\.js)?)\b/i);
  return nodeMatch?.[1]?.replace(/\\/g, '/') ?? null;
}

export function isOptionalVerifierRequest(task: string): boolean {
  return /\brun\b[^.?!]*\bif possible\b|\bif possible\b[^.?!]*\brun\b/i.test(task);
}

export function isExecutorCommandPlaceholder(command: string): boolean {
  return /<cmd-without-cmd-slash-c-or-cd>/i.test(command.trim());
}
