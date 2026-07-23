import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import { extractExplicitFilePaths } from './liteFullRouter.js';

export type SmallFixScope =
  | {
      mode: 'single';
      targetFile: string;
      verifierCommand: string;
      projectRoot: string;
    }
  | {
      mode: 'dual';
      sourceFile: string;
      testFile: string;
      verifierCommand: string;
      projectRoot: string;
    }
  | {
      mode: 'multi';
      targetFiles: string[];
      verifierCommand: string;
      projectRoot: string;
    };

export const MAX_SEQUENTIAL_FIX_FILES = 4;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function readPackageTestCommand(projectRoot: string): string | null {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.['test'] === 'string' ? 'npm test' : null;
  } catch {
    return null;
  }
}

const LOCAL_VERIFIER_COMMANDS = [
  /^npm\s+test$/i,
  /^npm\s+run\s+test$/i,
  /^node\s+--test$/i,
  /^npx\s+tsx\s+[\w./\\-]+$/i,
  /^npm\s+--prefix\s+.+?\s+run\s+\S+$/i,
];

function extractVerifierCommand(task: string): string | null {
  const explicit = task.match(
    /\brun\s+((?:npm|node|npx)\s+.+?)\s+before\s+(?:completing|completion|finishing)/i,
  );
  const candidate = explicit?.[1]?.trim().replace(/[.。]+$/, '');
  if (candidate && LOCAL_VERIFIER_COMMANDS.some((pattern) => pattern.test(candidate))) {
    return candidate;
  }
  if (/\bfailing\s+(?:node\s+)?test\b/i.test(task) && /\bnpm\s+test\b/i.test(task)) {
    return 'npm test';
  }
  return candidate ?? null;
}

function isTestLikePath(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) || /(?:^|\/)tests?\//i.test(path);
}

function isSourceLikePath(path: string): boolean {
  return /\.(?:m?[jt]s|cjs|tsx|jsx|py|go|rs)$/i.test(path) && !isTestLikePath(path);
}

export function hasFixIntent(task: string): boolean {
  return /\b(fix|repair|patch|implement|update|edit|change|correct|resolve)\b/i.test(task);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of paths) {
    const normalized = normalizeRelativePath(path);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export function extractPathsFromDiscovery(input: {
  observations: string;
  toolCallLog?: ToolCallLog[];
  projectRoot: string;
}): string[] {
  const paths: string[] = [];

  for (const entry of input.toolCallLog ?? []) {
    const target = entry.target.trim();
    if (!target) {
      continue;
    }
    const candidate = normalizeRelativePath(target.split('@')[0]?.trim() ?? target);
    if (!candidate || candidate === '.') {
      continue;
    }
    const absolute = resolve(input.projectRoot, candidate);
    if (existsSync(absolute) && isInsideRoot(input.projectRoot, absolute)) {
      paths.push(candidate);
    }
  }

  for (const line of input.observations.split('\n')) {
    const header = line.match(/^###\s+(?:read_file|file_read|grep|glob)\s+(.+)$/i);
    if (!header?.[1]) {
      continue;
    }
    const candidate = normalizeRelativePath(header[1].split('@')[0]?.trim() ?? header[1]);
    const absolute = resolve(input.projectRoot, candidate);
    if (existsSync(absolute) && isInsideRoot(input.projectRoot, absolute)) {
      paths.push(candidate);
    }
  }

  return uniquePaths(paths);
}

export function isAmbiguousBroadRefactor(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(refactor the codebase|refactor the whole repo|refactor the entire repo|refactor the project|refactor the entire project|refactor all files|rewrite the codebase|rewrite the repo)\b/i.test(
    normalized,
  );
}

export function extractFileNamesFromTask(task: string): string[] {
  const names = new Set<string>();
  const regex = /\b([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/g;
  for (const match of task.matchAll(regex)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

export function findFilesInProject(projectRoot: string, fileNames: string[]): string[] {
  const matchedPaths: string[] = [];
  const lowercaseNames = new Set(fileNames.map((n) => n.toLowerCase()));
  if (lowercaseNames.size === 0) {
    return [];
  }

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryName = entry.name;
      const fullPath = join(dir, entryName);
      if (entry.isDirectory()) {
        if (
          entryName === 'node_modules' ||
          entryName === 'dist' ||
          entryName === 'build' ||
          entryName === '.git' ||
          entryName === '.cache'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (lowercaseNames.has(entryName.toLowerCase())) {
          matchedPaths.push(relative(projectRoot, fullPath));
        }
      }
    }
  }

  walk(projectRoot);
  return matchedPaths;
}

export function extractOnlyEditFile(task: string): string | null {
  const patterns = [/\bonly\s+(?:edit|modify|change|touch)\s+(.+)$/i, /\bedit\s+only\s+(.+)$/i];
  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match?.[1]) {
      const clause = match[1].split(/\.\s|;|\n|!|\.$/)[0] || '';
      const fileRegex = /\b([A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]+)\b/g;
      const files: string[] = [];
      for (const m of clause.matchAll(fileRegex)) {
        if (m[1]) {
          files.push(normalizeRelativePath(m[1]));
        }
      }
      if (files.length === 1) {
        return files[0]!;
      }
    }
  }
  return null;
}

export function detectMultiFileSmallFix(task: string, projectRoot: string): SmallFixScope | null {
  if (isAmbiguousBroadRefactor(task) || extractOnlyEditFile(task)) {
    return null;
  }

  // Get explicit paths (e.g. src/math.ts)
  const explicitPaths = extractExplicitFilePaths(task).map((path) => normalizeRelativePath(path));

  // Get implicit names (e.g. math.ts)
  const implicitNames = extractFileNamesFromTask(task);
  const resolvedImplicitPaths = findFilesInProject(projectRoot, implicitNames);

  const combinedPaths = uniquePaths([...explicitPaths, ...resolvedImplicitPaths]).filter((path) => {
    const absolutePath = resolve(projectRoot, path);
    return isInsideRoot(projectRoot, absolutePath) && existsSync(absolutePath);
  });

  if (combinedPaths.length < 2 || combinedPaths.length > MAX_SEQUENTIAL_FIX_FILES) {
    return null;
  }

  const testFiles = combinedPaths.filter(isTestLikePath);
  const sourceFiles = combinedPaths.filter(isSourceLikePath);
  const verifierCommand = extractVerifierCommand(task) ?? readPackageTestCommand(projectRoot);

  if (testFiles.length === 1 && sourceFiles.length === 1 && combinedPaths.length === 2) {
    if (!verifierCommand) {
      return null;
    }
    return {
      mode: 'dual',
      sourceFile: sourceFiles[0]!,
      testFile: testFiles[0]!,
      verifierCommand,
      projectRoot,
    };
  }

  if (!verifierCommand) {
    return null;
  }

  return {
    mode: 'multi',
    targetFiles: combinedPaths,
    verifierCommand,
    projectRoot,
  };
}

export function resolveFixScopeFromDiscovery(input: {
  task: string;
  projectRoot: string;
  observations: string;
  toolCallLog?: ToolCallLog[];
}): SmallFixScope | null {
  if (isAmbiguousBroadRefactor(input.task)) {
    return null;
  }

  const multi = detectMultiFileSmallFix(input.task, input.projectRoot);
  if (multi) {
    return multi;
  }

  const discoveredPaths = extractPathsFromDiscovery(input);
  const explicitPaths = uniquePaths(
    extractExplicitFilePaths(input.task).map((path) => normalizeRelativePath(path)),
  );
  const sourceCandidates = uniquePaths(
    [...explicitPaths, ...discoveredPaths].filter((path) => {
      const absolute = resolve(input.projectRoot, path);
      return (
        isInsideRoot(input.projectRoot, absolute) && existsSync(absolute) && isSourceLikePath(path)
      );
    }),
  );

  const verifier = extractVerifierCommand(input.task) ?? readPackageTestCommand(input.projectRoot);

  if (sourceCandidates.length === 1 && verifier) {
    return {
      mode: 'single',
      targetFile: sourceCandidates[0]!,
      verifierCommand: verifier,
      projectRoot: input.projectRoot,
    };
  }

  if (sourceCandidates.length >= 2 && sourceCandidates.length <= MAX_SEQUENTIAL_FIX_FILES) {
    if (verifier) {
      return {
        mode: 'multi',
        targetFiles: sourceCandidates,
        verifierCommand: verifier,
        projectRoot: input.projectRoot,
      };
    }
  }

  return null;
}

export function listSequentialFixTargets(scope: SmallFixScope): string[] {
  if (scope.mode === 'single') {
    return [scope.targetFile];
  }
  if (scope.mode === 'dual') {
    return [scope.sourceFile, scope.testFile];
  }
  return [...scope.targetFiles];
}
