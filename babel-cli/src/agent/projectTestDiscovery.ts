/**
 * Project test-command discovery — lightweight helpers.
 *
 * Discovers the project's standard test commands from common config files
 * so gate rejection messages can suggest HOW to verify, not just that
 * verification is required.
 *
 * Pure functions (no fs I/O) at the top — callers pass parsed config objects.
 * The I/O-heavy `discoverProjectTestCommands(projectRoot)` function at the
 * bottom does the actual filesystem probing and delegates to these pure helpers.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * Discovered test command with a source label for traceability.
 */
export interface DiscoveredTestCommand {
  command: string;
  source: string; // e.g. "package.json scripts.test", "Makefile", "convention"
}

/**
 * Extract test commands from a parsed package.json object.
 * Checks scripts.test and any script whose name contains "test".
 */
export function testCommandsFromPackageJson(
  pkg: { scripts?: Record<string, string> } | null | undefined,
): DiscoveredTestCommand[] {
  if (!pkg?.scripts) return [];
  const out: DiscoveredTestCommand[] = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (typeof command === 'string' && command.trim()) {
      if (name === 'test' || /\btest\b/.test(name)) {
        out.push({
          command: name === 'test' ? 'npm test' : `npm run ${name}`,
          source: `package.json scripts.${name}`,
        });
      }
    }
  }
  return out;
}

/**
 * Extract test commands from a Makefile string.
 * Looks for a "test" or "check" target.
 */
export function testCommandsFromMakefile(
  content: string | null | undefined,
): DiscoveredTestCommand[] {
  if (!content) return [];
  const out: DiscoveredTestCommand[] = [];
  // Match "test:" or "check:" targets
  if (/^test\s*:/m.test(content)) {
    out.push({ command: 'make test', source: 'Makefile' });
  }
  if (/^check\s*:/m.test(content)) {
    out.push({ command: 'make check', source: 'Makefile' });
  }
  return out;
}

/**
 * Detect test commands from common project conventions.
 * Checks for presence of config files (caller passes booleans for each).
 */
export function testCommandsFromConventions(opts: {
  hasPytestConfig: boolean;    // pytest.ini, pyproject.toml [tool.pytest], setup.cfg [tool:pytest]
  hasUnittestFiles?: boolean
  hasJestConfig: boolean;      // jest.config.*, "jest" in package.json
  hasCargoToml: boolean;       // Cargo.toml (Rust)
  hasGoMod: boolean;           // go.mod (Go)
  hasGradleBuild: boolean;     // build.gradle or build.gradle.kts
  hasMavenPom: boolean;        // pom.xml
}): DiscoveredTestCommand[] {
  const out: DiscoveredTestCommand[] = [];
  if (opts.hasPytestConfig) {
    out.push({ command: 'python -m pytest', source: 'convention (pytest config)' });
  }
  if (opts.hasUnittestFiles) {
    const python = process.platform === 'win32' ? 'python' : 'python3'
    out.push({ command: `${python} -m unittest discover`, source: 'convention (Python test files)' })
  }
  if (opts.hasJestConfig) {
    out.push({ command: 'npx jest', source: 'convention (jest config)' });
  }
  if (opts.hasCargoToml) {
    out.push({ command: 'cargo test', source: 'convention (Cargo.toml)' });
  }
  if (opts.hasGoMod) {
    out.push({ command: 'go test ./...', source: 'convention (go.mod)' });
  }
  if (opts.hasGradleBuild) {
    out.push({ command: './gradlew test', source: 'convention (Gradle)' });
  }
  if (opts.hasMavenPom) {
    out.push({ command: 'mvn test', source: 'convention (Maven)' });
  }
  return out;
}

/**
 * Merge and deduplicate discovered commands, keeping the highest-priority
 * source for each unique command string.
 */
export function mergeTestCommands(
  ...sources: DiscoveredTestCommand[][]
): DiscoveredTestCommand[] {
  const seen = new Map<string, string>();
  const out: DiscoveredTestCommand[] = [];
  for (const cmds of sources) {
    for (const c of cmds) {
      const existing = seen.get(c.command);
      if (!existing) {
        seen.set(c.command, c.source);
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * Format discovered commands as a short comma-separated string for
 * injection into gate messages. Returns empty string when no commands.
 */
export function formatTestCommandsForGate(
  commands: DiscoveredTestCommand[],
): string {
  if (commands.length === 0) return '';
  const names = commands.slice(0, 4).map((c) => c.command);
  if (commands.length > 4) names.push('...');
  return names.join(', ');
}

/** Give the provider the current workspace's development check options. */
export function formatTestDiscoveryGuidance(commands: DiscoveredTestCommand[]): string {
  const npmRunPrefix = 'npm run '
  const safeCommands = commands.filter(({ command }) => {
    // Package script names come from the repository. Only offer plain tokens
    // as command arguments in the system prompt.
    if (!command.startsWith(npmRunPrefix)) return true
    const name = command.slice(npmRunPrefix.length)
    return name.length <= 128 && /^[A-Za-z0-9_]/.test(name) && !/[^A-Za-z0-9_.:-]/.test(name)
  })
  const listed = formatTestCommandsForGate(safeCommands)
  if (listed) {
    return `Test discovery: ${listed}. Use a relevant check when it is available and authorized. ` +
      'Keep a new check diagnostic until the contract accepts it.'
  }
  return 'Test discovery: the host found no project test command from repository metadata or conventional test files. ' +
    'Inspect the repository language and available test configuration. If the task authorizes verification and a compatible ' +
    'runner is available, a focused requirement-based development check can guide the work. Keep a new check diagnostic ' +
    'until the contract accepts it. If no check can run, report the specific missing prerequisite. A command denied before ' +
    'dispatch did not run. Distinguish that from a command that started and failed.'
}

/**
 * Discover project test commands by probing the filesystem at `projectRoot`.
 * Checks package.json scripts, Makefile targets, and common test-runner
 * config conventions. Synchronous so callers can use it in constructors.
 */
export function discoverProjectTestCommands(
  projectRoot: string,
  options: { includeUnittestHints?: boolean } = {},
): DiscoveredTestCommand[] {
  const found: DiscoveredTestCommand[][] = [];

  // package.json
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
      found.push(testCommandsFromPackageJson(pkg as { scripts?: Record<string, string> }));
    }
  } catch {
    // ignore parse failures
  }

  // Makefile
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    try {
      const mfPath = join(projectRoot, name);
      if (existsSync(mfPath)) {
        const content = readFileSync(mfPath, 'utf-8');
        found.push(testCommandsFromMakefile(content));
        break;
      }
    } catch {
      // ignore
    }
  }

  // Convention-based detection from config files present in the project root
  const entries = (() => {
    try { return readdirSync(projectRoot, { withFileTypes: true }); } catch { return []; }
  })();
  const rootEntries = entries.map(entry => entry.name)
  const rootFiles = new Set(rootEntries.map((e) => e.toLowerCase()));

  found.push(
    testCommandsFromConventions({
      hasPytestConfig:
        rootFiles.has('pytest.ini') ||
        rootFiles.has('pyproject.toml') ||
        rootFiles.has('setup.cfg') ||
        rootFiles.has('conftest.py'),
      hasUnittestFiles: options.includeUnittestHints === true &&
        entries.some(entry => entry.isFile() && /^test_.*\.py$/.test(entry.name)),
      hasJestConfig:
        rootFiles.has('jest.config.js') ||
        rootFiles.has('jest.config.ts') ||
        rootFiles.has('jest.config.cjs') ||
        rootFiles.has('jest.config.mjs') ||
        rootEntries.some((e) => e.startsWith('jest.config.')),
      hasCargoToml: rootFiles.has('cargo.toml'),
      hasGoMod: rootFiles.has('go.mod'),
      hasGradleBuild:
        rootFiles.has('build.gradle') || rootFiles.has('build.gradle.kts'),
      hasMavenPom: rootFiles.has('pom.xml'),
    }),
  );

  return mergeTestCommands(...found);
}
