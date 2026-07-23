/**
 * autoVerifierDiscovery.ts — Auto-discover verifier commands (P1.3)
 *
 * Scans project configuration files to discover available test/verify commands
 * beyond just package.json. Supports:
 *   - Node.js: package.json scripts (test, lint, typecheck)
 *   - Python: pyproject.toml, pytest.ini, setup.cfg, Makefile
 *   - Rust: Cargo.toml
 *   - Go: go test (detected via go.mod)
 *   - Java/Kotlin: build.gradle, pom.xml, mvnw
 *   - C/C++: Makefile, CMakeLists.txt
 *   - Generic: Makefile with test/check targets
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredVerifierCommand {
  /** Human label (e.g. "npm test", "cargo test") */
  label: string;
  /** The shell command to run */
  command: string;
  /** Working directory for the command (relative to project root) */
  cwd?: string;
  /** Priority: 1=highest (preferred), 2=fallback, 3=supplementary */
  priority: number;
  /** Source of the discovery (e.g. "package.json", "Cargo.toml") */
  source: string;
}

export interface VerifierDiscoveryResult {
  commands: DiscoveredVerifierCommand[];
  sources: string[];
  summary: string;
}

// ── Discovery Functions ─────────────────────────────────────────────────────

function discoverNodeScripts(root: string): DiscoveredVerifierCommand[] {
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const scripts = (pkg['scripts'] ?? {}) as Record<string, string>;
    const commands: DiscoveredVerifierCommand[] = [];

    const testScripts: Array<{ key: string; label: string; priority: number }> = [
      { key: 'test', label: 'npm test', priority: 1 },
      { key: 'test:unit', label: 'npm run test:unit', priority: 1 },
      { key: 'test:integration', label: 'npm run test:integration', priority: 2 },
      { key: 'lint', label: 'npm run lint', priority: 2 },
      { key: 'typecheck', label: 'npm run typecheck', priority: 2 },
      { key: 'check', label: 'npm run check', priority: 2 },
      { key: 'build', label: 'npm run build', priority: 3 },
    ];

    for (const { key, label, priority } of testScripts) {
      if (scripts[key]) {
        commands.push({
          label,
          command: key === 'test' ? 'npm test' : `npm run ${key}`,
          priority,
          source: 'package.json',
        });
      }
    }

    return commands;
  } catch {
    return [];
  }
}

function discoverPythonScripts(root: string): DiscoveredVerifierCommand[] {
  const commands: DiscoveredVerifierCommand[] = [];

  // pyproject.toml with pytest
  const pyprojectPath = resolve(root, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (/\bpytest\b/i.test(content) || /\[tool\.pytest\]/.test(content)) {
        commands.push({
          label: 'pytest',
          command: 'pytest',
          priority: 1,
          source: 'pyproject.toml',
        });
      }
      if (/\[tool\.ruff\]/.test(content) || /\bruff\b/i.test(content)) {
        commands.push({
          label: 'ruff check',
          command: 'ruff check',
          priority: 2,
          source: 'pyproject.toml',
        });
      }
    } catch {
      /* best effort */
    }
  }

  // pytest.ini, setup.cfg, tox.ini
  for (const cfg of ['pytest.ini', 'setup.cfg', 'tox.ini']) {
    if (existsSync(resolve(root, cfg))) {
      commands.push({
        label: 'pytest',
        command: 'pytest',
        priority: 1,
        source: cfg,
      });
      break;
    }
  }

  return commands;
}

function discoverRustScripts(root: string): DiscoveredVerifierCommand[] {
  const cargoPath = resolve(root, 'Cargo.toml');
  if (!existsSync(cargoPath)) return [];

  try {
    const content = readFileSync(cargoPath, 'utf-8');
    const commands: DiscoveredVerifierCommand[] = [];

    // cargo test
    if (/\[.*test.*\]/i.test(content) || /\[dependencies\]/.test(content)) {
      commands.push({
        label: 'cargo test',
        command: 'cargo test',
        priority: 1,
        source: 'Cargo.toml',
      });
    }

    // cargo check
    commands.push({
      label: 'cargo check',
      command: 'cargo check',
      priority: 2,
      source: 'Cargo.toml',
    });

    // cargo clippy
    if (/clippy/i.test(content)) {
      commands.push({
        label: 'cargo clippy',
        command: 'cargo clippy',
        priority: 2,
        source: 'Cargo.toml',
      });
    }

    return commands;
  } catch {
    return [];
  }
}

function discoverGoScripts(root: string): DiscoveredVerifierCommand[] {
  if (!existsSync(resolve(root, 'go.mod'))) return [];

  return [
    {
      label: 'go test ./...',
      command: 'go test ./...',
      priority: 1,
      source: 'go.mod',
    },
    {
      label: 'go vet ./...',
      command: 'go vet ./...',
      priority: 2,
      source: 'go.mod',
    },
  ];
}

function discoverJavaScripts(root: string): DiscoveredVerifierCommand[] {
  const commands: DiscoveredVerifierCommand[] = [];

  // Gradle
  const gradlePath = resolve(root, 'build.gradle');
  const gradleKtsPath = resolve(root, 'build.gradle.kts');
  if (existsSync(gradlePath) || existsSync(gradleKtsPath)) {
    commands.push({
      label: 'gradle test',
      command: process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test',
      priority: 1,
      source: 'build.gradle',
    });
  }

  // Maven
  if (existsSync(resolve(root, 'pom.xml'))) {
    commands.push({
      label: 'mvn test',
      command: process.platform === 'win32' ? 'mvnw.cmd test' : 'mvn test',
      priority: 1,
      source: 'pom.xml',
    });
  }

  return commands;
}

function discoverMakefileScripts(root: string): DiscoveredVerifierCommand[] {
  const makefilePath = resolve(root, 'Makefile');
  if (!existsSync(makefilePath)) return [];

  try {
    const content = readFileSync(makefilePath, 'utf-8');
    const commands: DiscoveredVerifierCommand[] = [];

    // Look for test, check, verify targets
    const targetPattern = /^(\w+)\s*:/gm;
    let match;
    while ((match = targetPattern.exec(content)) !== null) {
      const target = match[1]!;
      if (target === 'test' || target === 'check') {
        commands.push({
          label: `make ${target}`,
          command: `make ${target}`,
          priority: target === 'test' ? 1 : 2,
          source: 'Makefile',
        });
      }
    }

    return commands;
  } catch {
    return [];
  }
}

function discoverCMakeScripts(root: string): DiscoveredVerifierCommand[] {
  if (!existsSync(resolve(root, 'CMakeLists.txt'))) return [];

  // Check if there's a build directory with CTest
  const buildDir = resolve(root, 'build');
  if (existsSync(resolve(buildDir, 'CTestTestfile.cmake'))) {
    return [
      {
        label: 'ctest',
        command: `cd build && ctest`,
        cwd: 'build',
        priority: 1,
        source: 'CMakeLists.txt',
      },
    ];
  }

  return [
    {
      label: 'cmake --build',
      command: `cmake --build ${buildDir}`,
      priority: 3,
      source: 'CMakeLists.txt',
    },
  ];
}

// ── Main Discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discover verifier commands for a project by scanning configuration files.
 * Returns commands sorted by priority (highest first).
 */
export function discoverVerifierCommands(root: string): VerifierDiscoveryResult {
  const allCommands: DiscoveredVerifierCommand[] = [];
  const sources: string[] = [];

  const discoverers: Array<{ name: string; fn: (root: string) => DiscoveredVerifierCommand[] }> = [
    { name: 'Node.js', fn: discoverNodeScripts },
    { name: 'Python', fn: discoverPythonScripts },
    { name: 'Rust', fn: discoverRustScripts },
    { name: 'Go', fn: discoverGoScripts },
    { name: 'Java', fn: discoverJavaScripts },
    { name: 'Makefile', fn: discoverMakefileScripts },
    { name: 'CMake', fn: discoverCMakeScripts },
  ];

  for (const { name, fn } of discoverers) {
    try {
      const found = fn(root);
      if (found.length > 0) {
        allCommands.push(...found);
        sources.push(name);
      }
    } catch {
      /* best effort per discoverer */
    }
  }

  // Sort by priority (1 = highest)
  allCommands.sort((a, b) => a.priority - b.priority);

  const testCommands = allCommands.filter((c) => c.priority === 1);
  const summary =
    testCommands.length > 0
      ? `Discovered ${testCommands.length} preferred verifier(s): ${testCommands.map((c) => c.label).join(', ')}.`
      : allCommands.length > 0
        ? `No preferred verifiers found. ${allCommands.length} fallback(s) available.`
        : 'No automated verifier commands discovered.';

  return {
    commands: allCommands,
    sources,
    summary,
  };
}
