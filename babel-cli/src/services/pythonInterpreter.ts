import { spawnSync } from 'node:child_process';

/**
 * Portable Python interpreter resolution shared by host-side checks.
 *
 * Stock macOS and Debian/Ubuntu ship only `python3`; Windows typically ships
 * `py` (launcher) and/or `python`. Never hardcode `python`.
 */

export interface PythonInterpreter {
  /** Executable to spawn. */
  bin: string;
  /** Arguments that must precede script args (e.g. `['-3']` for `py`). */
  prefixArgs: string[];
  /** Human-readable label of the candidate that matched. */
  label: string;
}

export interface PythonCandidate {
  label: string;
  bin: string;
  args?: string[];
}

/** Default fallback binary name when no probing is possible/desired. */
export function defaultPythonBin(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'python' : 'python3';
}

/** Ordered generic candidates for the given platform. */
export function pythonCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  const override = env['BABEL_WORKSPACE_PYTHON']?.trim() || env['BABEL_PYTHON']?.trim();
  if (override) out.push({ label: `env:${override}`, bin: override });
  if (platform === 'win32') {
    out.push({ label: 'py -3', bin: 'py', args: ['-3'] });
    out.push({ label: 'python', bin: 'python' });
    out.push({ label: 'python3', bin: 'python3' });
  } else {
    out.push({ label: 'python3', bin: 'python3' });
    out.push({ label: 'python', bin: 'python' });
  }
  return out;
}

export type PythonProbe = (bin: string, args: string[]) => boolean;

const defaultProbe: PythonProbe = (bin, args) => {
  try {
    const r = spawnSync(bin, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
};

const cache = new Map<string, PythonInterpreter | null>();

/**
 * Resolve a working Python 3 interpreter, or null when none is installed.
 * Results are cached per platform+override so per-edit checks stay cheap.
 */
export function resolvePythonInterpreter(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: PythonProbe;
  noCache?: boolean;
}): { interpreter: PythonInterpreter | null; tried: string[] } {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const candidates = pythonCandidates(platform, env);
  const tried = candidates.map((c) => c.label);
  const useCache = !options?.noCache && !options?.probe;
  const key = `${platform}|${tried.join(',')}`;
  if (useCache && cache.has(key)) return { interpreter: cache.get(key) ?? null, tried };
  const probe = options?.probe ?? defaultProbe;
  let found: PythonInterpreter | null = null;
  for (const c of candidates) {
    const args = c.args ?? [];
    if (probe(c.bin, args)) {
      found = { bin: c.bin, prefixArgs: args, label: c.label };
      break;
    }
  }
  if (useCache) cache.set(key, found);
  return { interpreter: found, tried };
}

/** Test hook. */
export function clearPythonInterpreterCache(): void {
  cache.clear();
}
