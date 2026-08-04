/**
 * Structural verifier identity — full-suite vs targeted scope and directional coverage.
 *
 * Normative: docs/architecture/HARNESS_ARCHITECTURE_V1.md §6.8
 * Golden: examples/golden-harness/negative/narrow-verifier-vs-broad-required.json
 *
 * Rules:
 * - Identity is family + scope (+ selectors for targeted).
 * - Directional coverage: a full-suite run MAY satisfy a targeted requirement;
 *   a targeted run MUST NOT satisfy a full-suite requirement.
 * - Different families never satisfy each other (e.g. npm test ≠ vitest).
 *
 * Pure helpers; no I/O.
 */

export type VerifierScope = 'full' | 'targeted' | 'unknown';

export interface VerifierIdentity {
  /** Runner family key, e.g. npm-test, vitest, pytest, jest, node-test. */
  family: string;
  scope: VerifierScope;
  /** Normalized path / filter selectors when scope is targeted. */
  targetSelectors: string[];
  /** Stable key for plan dedupe (family + scope + selectors). */
  identityKey: string;
  displayCommand: string;
}

const PATH_LIKE_RE =
  /[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$|\.py$|\.go$|(?:^|[/\\])(?:tests?|__tests__)(?:[/\\]|$)/i;

const FILTER_FLAGS_WITH_VALUE = new Set([
  '-t',
  '--testnamepattern',
  '--test-name-pattern',
  '-g',
  '--grep',
  '-k',
  '--testpathpattern',
  '--test-path-pattern',
  '-f',
  '--filter',
  '--testpathignorepatterns',
]);

const BOOLEAN_RUNNER_FLAGS = new Set([
  'run',
  'test',
  '--run',
  '--watch=false',
  '--watchAll=false',
  '--coverage',
  '--ci',
  '--passwithnodiff',
  '--silent',
  '--verbose',
  '-q',
  '--quiet',
  '-v',
  '--bail',
  '--runinband',
  '--detectopenhandles',
  '--forceexit',
  '--no-cache',
  '--update',
  '-u',
  '--watch',
  '--ui',
  '--reporter=verbose',
  '--reporter=dot',
  '--allow-no-tests',
]);

/**
 * Classify structural scope of a verifier command.
 */
export function classifyVerifierScope(command: string): VerifierScope {
  return analyzeVerifierIdentity(command)?.scope ?? 'unknown';
}

/**
 * Analyze structural identity of a verifier command.
 * Returns null only when the command is empty after clean.
 */
export function analyzeVerifierIdentity(command: string): VerifierIdentity | null {
  const display = cleanCommand(command);
  if (!display) return null;

  const tokens = tokenizeCommand(display);
  if (tokens.length === 0) return null;

  const stripped = stripLauncher(tokens);
  if (stripped.length === 0) {
    return identityOf('unknown', 'unknown', [], display);
  }

  const executable = normalizeExecutable(stripped[0]!);
  const args = stripped.slice(1).map(normalizeArg);
  const family = resolveFamily(executable, args);
  if (!family) {
    return identityOf('unknown', 'unknown', [], display);
  }

  const selectors = extractTargetSelectors(family, executable, args);
  const scope: VerifierScope = selectors.length > 0 ? 'targeted' : 'full';
  return identityOf(family, scope, selectors, display);
}

/**
 * Whether an actual execution satisfies a required verifier command.
 * Directional: full covers targeted; targeted does not cover full.
 */
export function satisfiesVerifierRequirement(required: string, actual: string): boolean {
  const req = analyzeVerifierIdentity(required);
  const act = analyzeVerifierIdentity(actual);
  if (!req || !act) {
    return cleanCommand(required).toLowerCase() === cleanCommand(actual).toLowerCase();
  }

  if (req.family === 'unknown' || act.family === 'unknown') {
    // Unknown families: only exact identity-key match (no directional promotion).
    return req.identityKey === act.identityKey;
  }

  if (req.family !== act.family) {
    return false;
  }

  if (req.scope === 'full') {
    // Only a full-suite actual can satisfy a full-suite requirement.
    return act.scope === 'full';
  }

  if (req.scope === 'targeted') {
    // Directional coverage: full suite covers any targeted requirement in-family.
    if (act.scope === 'full') return true;
    if (act.scope !== 'targeted') return false;
    return selectorsCovered(req.targetSelectors, act.targetSelectors);
  }

  // required unknown scope within known family: match same key only
  return req.identityKey === act.identityKey;
}

/**
 * Symmetric match used only for optional-plan overlap filtering.
 * Prefer {@link satisfiesVerifierRequirement} for plan-vs-execution.
 */
export function sameVerifierIdentity(left: string, right: string): boolean {
  const a = analyzeVerifierIdentity(left);
  const b = analyzeVerifierIdentity(right);
  if (!a || !b) {
    return cleanCommand(left).toLowerCase() === cleanCommand(right).toLowerCase();
  }
  return a.identityKey === b.identityKey;
}

function identityOf(
  family: string,
  scope: VerifierScope,
  targetSelectors: string[],
  displayCommand: string,
): VerifierIdentity {
  const selectors = [...new Set(targetSelectors.map((s) => s.toLowerCase()))].sort();
  const identityKey =
    scope === 'targeted'
      ? `${family}#targeted:${selectors.join(',')}`
      : `${family}#${scope}`;
  return {
    family,
    scope,
    targetSelectors: selectors,
    identityKey,
    displayCommand,
  };
}

function resolveFamily(executable: string, args: readonly string[]): string | null {
  if (executable === 'npx') {
    const body = skipLeadingOptions(args);
    const tool = body[0];
    if (!tool) return null;
    if (tool === 'vitest') return 'vitest';
    if (tool === 'jest') return 'jest';
    if (tool === 'mocha') return 'mocha';
    return `npx-${tool}`;
  }
  // Package managers: npm/pnpm/yarn/bun test scripts share family npm-test.
  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn' || executable === 'bun') {
    const body = skipLeadingOptions(args);
    if (body[0] === 'test') return 'npm-test';
    if (body[0] === 'run' && body[1] === 'test') return 'npm-test';
    if (body[0] === 'run' && body[1]) return `npm-run-${body[1]}`;
    return null;
  }
  if (executable === 'vitest') return 'vitest';
  if (executable === 'jest') return 'jest';
  if (executable === 'mocha') return 'mocha';
  if (executable === 'pytest') return 'pytest';
  if (executable === 'tsc') return args.includes('-b') ? 'tsc-b' : 'tsc';
  if (executable === 'node' && args.some((a) => a === '--test')) return 'node-test';
  if (executable === 'go' && skipLeadingOptions(args)[0] === 'test') return 'go-test';
  if (executable === 'cargo' && skipLeadingOptions(args)[0] === 'test') return 'cargo-test';
  if (executable === 'gradle' && skipLeadingOptions(args)[0] === 'test') return 'gradle-test';
  if (executable === 'gradlew' && skipLeadingOptions(args)[0] === 'test') return 'gradle-test';
  if (executable === 'deno' && skipLeadingOptions(args)[0] === 'test') return 'deno-test';
  if (executable === 'dotnet' && skipLeadingOptions(args)[0] === 'test') return 'dotnet-test';
  if (
    (executable === 'python' || executable === 'python3' || executable === 'py') &&
    args[0] === '-m' &&
    (args[1] === 'pytest' || args[1] === 'unittest')
  ) {
    return args[1] === 'pytest' ? 'pytest' : 'unittest';
  }
  return null;
}

function extractTargetSelectors(
  family: string,
  executable: string,
  args: readonly string[],
): string[] {
  const runnerArgs = argsAfterRunner(family, executable, args);
  const selectors: string[] = [];

  for (let i = 0; i < runnerArgs.length; i += 1) {
    const token = runnerArgs[i]!;
    if (token === '--') {
      // Remaining after bare `--` may include suite flags and paths.
      continue;
    }
    if (FILTER_FLAGS_WITH_VALUE.has(token)) {
      const value = runnerArgs[i + 1];
      if (value && !value.startsWith('-')) {
        selectors.push(value);
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--testnamepattern=') || token.startsWith('--grep=')) {
      selectors.push(token.slice(token.indexOf('=') + 1));
      continue;
    }
    if (token.startsWith('-') || BOOLEAN_RUNNER_FLAGS.has(token)) {
      continue;
    }
    // Positional: path, package, or test id
    if (PATH_LIKE_RE.test(token) || looksLikeTestSelector(token, family)) {
      selectors.push(normalizeSelector(token));
    }
  }

  return selectors;
}

function argsAfterRunner(
  family: string,
  executable: string,
  args: readonly string[],
): string[] {
  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn' || executable === 'bun') {
    const body = skipLeadingOptions(args);
    if (body[0] === 'test') {
      return body.slice(1);
    }
    if (body[0] === 'run' && body[1]) {
      return body.slice(2);
    }
    return body;
  }
  if (executable === 'npx') {
    const body = skipLeadingOptions(args);
    // drop tool name (vitest/jest)
    return body.slice(1);
  }
  if (family === 'node-test') {
    return args.filter((a) => a !== '--test');
  }
  if (family === 'pytest' && (executable === 'python' || executable === 'python3' || executable === 'py')) {
    // python -m pytest ...
    const mIdx = args.indexOf('-m');
    if (mIdx >= 0) return args.slice(mIdx + 2);
  }
  if (family === 'go-test' || family === 'cargo-test' || family === 'gradle-test' || family === 'deno-test' || family === 'dotnet-test') {
    const body = skipLeadingOptions(args);
    if (body[0] === 'test') return body.slice(1);
    return body;
  }
  if (family === 'vitest') {
    // vitest [run] ...
    const body = skipLeadingOptions(args);
    if (body[0] === 'run') return body.slice(1);
    return body;
  }
  if (family === 'jest' || family === 'mocha' || family === 'pytest' || family === 'unittest') {
    return skipLeadingOptions(args);
  }
  return [...args];
}

function looksLikeTestSelector(token: string, family: string): boolean {
  if (!token || token.startsWith('-')) return false;
  // node: package paths like ./pkg or github.com/...
  if (family === 'go-test' && (/^\.\//.test(token) || token.includes('...'))) return true;
  // cargo test filter names (no path) — treat bare identifiers after cargo test as targeted
  if (family === 'cargo-test' && /^[a-zA-Z_][\w:]*$/.test(token)) return true;
  // pytest node ids
  if (family === 'pytest' && token.includes('::')) return true;
  // generic: file-ish or nested path without leading dash
  if (/\.[a-z0-9]+$/i.test(token) && !token.startsWith('-')) return true;
  return false;
}

function selectorsCovered(required: readonly string[], actual: readonly string[]): boolean {
  if (required.length === 0) return true;
  const actualSet = new Set(actual.map((s) => s.toLowerCase()));
  // Every required selector must appear in actual (actual may be stricter / same).
  return required.every((sel) => actualSet.has(sel.toLowerCase()));
}

function normalizeSelector(token: string): string {
  return token.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function stripLauncher(tokens: readonly string[]): string[] {
  // No cmd.exe / shell wrappers expected for verifier lines; keep as-is.
  return [...tokens];
}

function skipLeadingOptions(args: readonly string[]): string[] {
  const out = [...args];
  while (out.length > 0 && (out[0] ?? '').startsWith('-') && out[0] !== '--') {
    out.shift();
  }
  return out;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function normalizeExecutable(token: string): string {
  const trimmed = token.replace(/^['"]|['"]$/g, '').trim();
  const base = trimmed.split(/[\\/]/).at(-1) ?? '';
  return base
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, '');
}

function normalizeArg(token: string): string {
  return token.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function cleanCommand(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(
      /\s+from\s+(?:the\s+)?[A-Za-z0-9_.\\/-]+(?:\s+(?:directory|folder|subdirectory))?$/i,
      '',
    )
    .replace(/[.。]\s*$/, '')
    .trim();
}
