/**
 * Compact repository map injected into the chat system prompt (R4 / L17).
 * Pure helper so unit tests can cover the preamble without spinning ChatEngine.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'runs',
  'artifacts',
  'runtime',
  '.claude',
  '.cursor',
  'coverage',
  '.nyc_output',
  'tmp',
]);

function isKeyConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'package.json' ||
    lower === 'tsconfig.json' ||
    lower === 'claude.md' ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower === '.gitignore' ||
    lower === 'dockerfile' ||
    lower === 'makefile' ||
    lower.endsWith('.toml') ||
    lower.endsWith('.cfg')
  );
}

export async function buildRepoMapPreamble(projectRoot: string): Promise<string> {
  try {
    let topDirs: string[] = [];
    let keyFiles: string[] = [];

    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });
      topDirs = entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map((e) => `${e.name}/`)
        .sort();
      keyFiles = entries
        .filter((e) => e.isFile() && !SKIP_DIRS.has(e.name))
        .filter((e) => isKeyConfigFile(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      // readdir failed — use empty lists
    }

    const lines: string[] = ['## Repository Map'];
    if (topDirs.length > 0) {
      lines.push(`- Top-level: ${topDirs.join(' ')}`);
    }
    if (keyFiles.length > 0) {
      lines.push(`- Key files: ${keyFiles.join(', ')}`);
    }

    try {
      const pkgPath = join(projectRoot, 'package.json');
      if (existsSync(pkgPath)) {
        const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
        const scripts = pkgJson['scripts'] as Record<string, string> | undefined;
        if (scripts) {
          if (scripts['build']) lines.push('- Build: npm run build');
          if (scripts['test']) lines.push('- Test: npm test');
          if (scripts['typecheck']) lines.push('- TypeCheck: npm run typecheck');
        }
      }
    } catch {
      // Best-effort
    }

    try {
      const tsconfigPath = join(projectRoot, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;
        if (compilerOptions && compilerOptions['strict'] === true) {
          lines.push('- TypeScript strict mode: true');
        }
      }
    } catch {
      // Best-effort
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
