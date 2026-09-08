/**
 * ripgrep.ts — Spawns `rg --json` and returns typed results.
 *
 * The riprep wrapper used by repoSearch.ts. Falls back to pure-JS if rg
 * is not installed.
 *
 * Arguments go directly to the executable on every platform, never a shell.
 * Output is capped at 5 MB (same as MAX_SHELL_OUTPUT_BYTES in sandbox.ts).
 */

import { spawnSync } from 'node:child_process';

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
    const result = spawnSync('rg', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      shell: false,
      windowsHide: true,
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

  // Pattern and path strings are data, including leading '-' and shell syntax.
  args.push('-e', options.pattern, '--');

  if (options.paths && options.paths.length > 0) {
    args.push(...options.paths);
  } else {
    // On Windows rg does not default to cwd; pass '.' explicitly.
    // On other platforms this is a harmless no-op equivalent.
    args.push('.');
  }

  const startTime = Date.now();

  const result = spawnSync('rg', args, {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  const elapsedMs = Date.now() - startTime;

  if (result.error && !result.stdout) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`ripgrep failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
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

  const result = spawnSync('rg', args, {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`ripgrep file listing failed: ${result.stderr?.trim() || `exit ${result.status}`}`);

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

  const result = spawnSync('rg', args, {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    encoding: 'utf-8',
    maxBuffer: MAX_RIPGREP_OUTPUT_BYTES,
    timeout: DEFAULT_RIPGREP_TIMEOUT_MS,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`ripgrep file listing failed: ${result.stderr?.trim() || `exit ${result.status}`}`);

  const stdout = result.stdout ?? '';
  const allLines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
  sortPathsByDepth(allLines);
  return allLines;
}
