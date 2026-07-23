/**
 * ripgrep.ts — Spawns `rg --json` and returns typed results.
 *
 * The riprep wrapper used by repoSearch.ts. Falls back to pure-JS if rg
 * is not installed.
 *
 * Windows path handling: uses cmd.exe /c rg ... (same pattern as sandbox.ts).
 * Output is capped at 5 MB (same as MAX_SHELL_OUTPUT_BYTES in sandbox.ts).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface RipgrepMatch {
  type: 'match';
  path: string;
  line: number;
  column: number;
  text: string;
  submatches: Array<{ start: number; end: number; text: string }>;
}

export interface RipgrepOptions {
  pattern: string;
  paths?: string[];
  glob?: string;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  maxMatches?: number;
  contextLines?: number;
  multiline?: boolean;
  gitignoreRespect?: boolean;
  type?: string;
}

export interface RipgrepResult {
  matches: RipgrepMatch[];
  truncated: boolean;
  elapsedMs: number;
}

// ─── Detection cache ────────────────────────────────────────────────────────────

let rgDetected: boolean | null = null;

/**
 * Returns true if `rg --version` succeeds. Result is cached after first call.
 * Use `resetRipgrepDetection()` in tests to clear the cache.
 */
export function detectRipgrep(): boolean {
  if (rgDetected !== null) {
    return rgDetected;
  }
  try {
    const isWin = process.platform === 'win32';
    const spawnCmd = isWin ? resolveWindowsCommandShell() : 'rg';
    const spawnArgs = isWin ? ['/d', '/c', 'rg', '--version'] : ['--version'];
    const result = spawnSync(spawnCmd, spawnArgs, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    rgDetected = result.status === 0;
  } catch {
    rgDetected = false;
  }
  return rgDetected;
}

/** Clear the cached ripgrep detection result. Useful in tests. */
export function resetRipgrepDetection(): void {
  rgDetected = null;
}

// ─── Windows shell resolution (mirrors sandbox.ts) ──────────────────────────────

function resolveWindowsCommandShell(): string {
  const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'];
  if (comspec && existsSync(comspec)) {
    return comspec;
  }
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const systemCmd = `${systemRoot}\\System32\\cmd.exe`;
  return existsSync(systemCmd) ? systemCmd : 'cmd.exe';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** Sort paths by depth (shallowest first), then alphabetically.
 *  Ensures root-level files survive truncation instead of being
 *  pushed out by deeply nested node_modules matches. */
export function sortPathsByDepth(paths: string[]): void {
  paths.sort((a, b) => {
    const depthA = (a.match(/\//g) ?? []).length;
    const depthB = (b.match(/\//g) ?? []).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });
}

// ─── Main API ───────────────────────────────────────────────────────────────────

const MAX_RIPGREP_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_RIPGREP_TIMEOUT_MS = 30_000;

/**
 * Run ripgrep with `--json` output and parse the results into typed matches.
 *
 * Throws if `rg` is not available (caller should fall back to pure-JS).
 */
export async function ripgrep(
  projectRoot: string,
  options: RipgrepOptions,
): Promise<RipgrepResult> {
  if (!detectRipgrep()) {
    throw new Error('ripgrep (rg) is not available');
  }

  const args: string[] = ['--json'];

  if (options.glob) {
    args.push('--glob', options.glob);
  }
  if (options.ignoreCase) {
    args.push('-i');
  }
  if (options.fixedStrings) {
    args.push('-F');
  }
  if (options.maxMatches) {
    args.push('-m', String(options.maxMatches));
  }
  if (options.contextLines) {
    args.push('-C', String(options.contextLines));
  }
  if (options.multiline) {
    args.push('-U', '--multiline-dotall');
  }
  if (options.gitignoreRespect === false) {
    args.push('--no-ignore');
  }
  if (options.type) {
    args.push('--type', options.type);
  }

  args.push(options.pattern);

  if (options.paths && options.paths.length > 0) {
    args.push(...options.paths);
  } else {
    // On Windows rg does not default to cwd; pass '.' explicitly.
    // On other platforms this is a harmless no-op equivalent.
    args.push('.');
  }

  const startTime = Date.now();

  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? resolveWindowsCommandShell() : 'rg';
  const spawnArgs = isWin ? ['/d', '/c', 'rg', ...args] : args;

  const result = spawnSync(spawnCmd, spawnArgs, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  const elapsedMs = Date.now() - startTime;

  if (result.error && !result.stdout) {
    throw result.error;
  }

  const matches: RipgrepMatch[] = [];
  let truncated = false;
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;

  const stdout = result.stdout ?? '';
  const lines = stdout.split('\n');

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'match') {
        const data = parsed.data;
        const rawSubmatches: Array<Record<string, unknown>> = data.submatches ?? [];
        const firstSub = rawSubmatches[0];

        const matchObj: RipgrepMatch = {
          type: 'match',
          path: data.path?.text ?? '',
          line: data.line_number ?? 0,
          column: ((firstSub?.start as number | undefined) ?? 0) + 1,
          text: data.lines?.text ?? '',
          submatches: rawSubmatches.map((sm) => ({
            start: (sm.start as number) ?? 0,
            end: (sm.end as number) ?? 0,
            text:
              ((sm.match as Record<string, unknown> | undefined)?.text as string | undefined) ?? '',
          })),
        };
        matches.push(matchObj);
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return { matches, truncated, elapsedMs };
}

/**
 * Run `rg --files --glob <pattern>` and return matching file paths.
 * Useful for fast glob matching when rg is available.
 */
export function rgGlobFiles(
  projectRoot: string,
  globPattern: string,
  maxFiles: number,
): { paths: string[]; truncated: boolean } {
  if (!detectRipgrep()) {
    throw new Error('ripgrep (rg) is not available');
  }

  const args: string[] = ['--files', '--glob', globPattern, '--no-ignore-vcs'];

  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? resolveWindowsCommandShell() : 'rg';
  const spawnArgs = isWin ? ['/d', '/c', 'rg', ...args] : args;

  const result = spawnSync(spawnCmd, spawnArgs, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const allLines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((p) => p.replace(/\\/g, '/'));

  sortPathsByDepth(allLines);

  const truncated = allLines.length > maxFiles;
  const paths = allLines.slice(0, maxFiles);

  return { paths, truncated };
}

/**
 * Run `rg --files` with an optional `--max-depth` and return paths.
 * Used by buildWorkspaceMap.
 */
export function rgListFiles(projectRoot: string, maxDepth?: number): string[] {
  if (!detectRipgrep()) {
    throw new Error('ripgrep (rg) is not available');
  }

  const args: string[] = ['--files'];
  if (maxDepth !== undefined) {
    args.push('--max-depth', String(maxDepth));
  }

  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? resolveWindowsCommandShell() : 'rg';
  const spawnArgs = isWin ? ['/d', '/c', 'rg', ...args] : args;

  const result = spawnSync(spawnCmd, spawnArgs, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const allLines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
  sortPathsByDepth(allLines);
  return allLines;
}
