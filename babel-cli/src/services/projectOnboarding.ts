import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type { ExecutionProfileName } from '../config/executionProfiles.js';

export interface OnboardingCommandSet {
  install: string[];
  build: string[];
  test: string[];
  lint: string[];
}

export interface ProjectOnboardingReport {
  schema_version: 1;
  generated_at: string;
  project_root: string;
  project_name: string;
  markers: string[];
  detected_stacks: string[];
  recommended_execution_profile: ExecutionProfileName;
  recommended_commands: OnboardingCommandSet;
  context_draft: string;
  notes: string[];
}

function fileExists(root: string, relativePath: string): boolean {
  return existsSync(join(root, relativePath));
}

function readTextIfExists(root: string, relativePath: string): string {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return '';
  }
  return readFileSync(fullPath, 'utf-8');
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const raw = readTextIfExists(root, 'package.json');
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function getPackageScripts(packageJson: Record<string, unknown> | null): Record<string, string> {
  const scripts = packageJson?.['scripts'];
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (fileExists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (fileExists(root, 'yarn.lock')) return 'yarn';
  if (fileExists(root, 'bun.lockb') || fileExists(root, 'bun.lock')) return 'bun';
  return 'npm';
}

function commandForScript(manager: 'pnpm' | 'yarn' | 'bun' | 'npm', scriptName: string): string {
  if (manager === 'npm') {
    return `npm run ${scriptName}`;
  }
  return `${manager} ${scriptName}`;
}

function addMarker(markers: string[], root: string, relativePath: string): void {
  if (fileExists(root, relativePath)) {
    markers.push(relativePath);
  }
}

function addStack(stacks: string[], stack: string): void {
  if (!stacks.includes(stack)) {
    stacks.push(stack);
  }
}

function topLevelHasExtension(root: string, extension: string): boolean {
  if (!existsSync(root)) {
    return false;
  }
  return readdirSync(root).some(entry => extname(entry).toLowerCase() === extension);
}

function buildContextDraft(report: Omit<ProjectOnboardingReport, 'context_draft'>): string {
  const commandLines = [
    ...report.recommended_commands.install.map(command => `- Install: \`${command}\``),
    ...report.recommended_commands.build.map(command => `- Build: \`${command}\``),
    ...report.recommended_commands.test.map(command => `- Test: \`${command}\``),
    ...report.recommended_commands.lint.map(command => `- Lint: \`${command}\``),
  ];

  return [
    `# PROJECT_CONTEXT.md - ${report.project_name}`,
    '',
    '## Babel Onboarding Snapshot',
    '',
    `- Project root: \`${report.project_root}\``,
    `- Recommended execution profile: \`${report.recommended_execution_profile}\``,
    `- Detected stacks: ${report.detected_stacks.length > 0 ? report.detected_stacks.map(stack => `\`${stack}\``).join(', ') : 'Unknown'}`,
    `- Markers: ${report.markers.length > 0 ? report.markers.map(marker => `\`${marker}\``).join(', ') : 'None detected'}`,
    '',
    '## Commands',
    '',
    ...(commandLines.length > 0 ? commandLines : ['- No deterministic commands detected yet. Add them after the first successful local run.']),
    '',
    '## Notes',
    '',
    '- Keep this file factual and evidence-backed.',
    '- Update it when build, test, or packaging commands change.',
  ].join('\n');
}

export function analyzeProjectRoot(
  projectRootInput: string,
  generatedAt: Date = new Date(),
): ProjectOnboardingReport {
  const projectRoot = resolve(projectRootInput);
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${projectRoot}`);
  }

  const markers: string[] = [];
  const stacks: string[] = [];
  const commands: OnboardingCommandSet = {
    install: [],
    build: [],
    test: [],
    lint: [],
  };
  const notes: string[] = [];

  for (const marker of [
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
    'pyproject.toml',
    'requirements.txt',
    'uv.lock',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'deno.json',
    'composer.json',
    'Dockerfile',
    'project.godot',
    'export_presets.cfg',
  ]) {
    addMarker(markers, projectRoot, marker);
  }

  if (topLevelHasExtension(projectRoot, '.sln') || topLevelHasExtension(projectRoot, '.csproj')) {
    markers.push('*.sln|*.csproj');
    addStack(stacks, 'dotnet');
    commands.build.push('dotnet build');
    commands.test.push('dotnet test');
  }

  const packageJson = readPackageJson(projectRoot);
  if (packageJson) {
    const manager = detectPackageManager(projectRoot);
    const scripts = getPackageScripts(packageJson);
    addStack(stacks, 'node');
    commands.install.push(manager === 'npm' ? 'npm install' : `${manager} install`);
    if (fileExists(projectRoot, 'tsconfig.json')) addStack(stacks, 'typescript');
    if (fileExists(projectRoot, 'vite.config.ts') || fileExists(projectRoot, 'vite.config.js')) addStack(stacks, 'vite');
    if (fileExists(projectRoot, 'next.config.js') || fileExists(projectRoot, 'next.config.mjs')) addStack(stacks, 'nextjs');
    if (scripts['build']) commands.build.push(commandForScript(manager, 'build'));
    if (scripts['test']) commands.test.push(commandForScript(manager, 'test'));
    if (scripts['lint']) commands.lint.push(commandForScript(manager, 'lint'));
    if (!scripts['test']) notes.push('package.json has no test script.');
  }

  if (fileExists(projectRoot, 'pyproject.toml') || fileExists(projectRoot, 'requirements.txt')) {
    addStack(stacks, 'python');
    if (fileExists(projectRoot, 'uv.lock')) {
      commands.install.push('uv sync');
    } else if (fileExists(projectRoot, 'requirements.txt')) {
      commands.install.push('python -m pip install -r requirements.txt');
    }
    if (fileExists(projectRoot, 'tests') || readTextIfExists(projectRoot, 'pyproject.toml').includes('pytest')) {
      commands.test.push('pytest');
    }
  }

  if (fileExists(projectRoot, 'Cargo.toml')) {
    addStack(stacks, 'rust');
    commands.build.push('cargo build');
    commands.test.push('cargo test');
  }

  if (fileExists(projectRoot, 'go.mod')) {
    addStack(stacks, 'go');
    commands.test.push('go test ./...');
  }

  if (fileExists(projectRoot, 'pom.xml')) {
    addStack(stacks, 'maven');
    commands.test.push('mvn test');
  }

  if (
    fileExists(projectRoot, 'build.gradle') ||
    fileExists(projectRoot, 'build.gradle.kts') ||
    fileExists(projectRoot, 'settings.gradle') ||
    fileExists(projectRoot, 'settings.gradle.kts')
  ) {
    addStack(stacks, 'gradle');
    const wrapper = process.platform === 'win32' && fileExists(projectRoot, 'gradlew.bat')
      ? 'gradlew.bat'
      : (fileExists(projectRoot, 'gradlew') ? 'gradlew' : 'gradle');
    commands.build.push(`${wrapper} build`);
    commands.test.push(`${wrapper} test`);
  }

  if (fileExists(projectRoot, 'deno.json')) {
    addStack(stacks, 'deno');
    commands.test.push('deno test');
  }

  if (fileExists(projectRoot, 'composer.json')) {
    addStack(stacks, 'php');
    commands.install.push('composer install');
  }

  if (fileExists(projectRoot, 'Dockerfile')) {
    addStack(stacks, 'container');
  }

  if (fileExists(projectRoot, 'project.godot')) {
    addStack(stacks, 'godot');
    if (topLevelHasExtension(projectRoot, '.tscn')) {
      markers.push('*.tscn');
    }
    commands.test.push('godot --headless --path . --quit');
  }

  const recommendedProfile: ExecutionProfileName =
    stacks.length === 0 && readdirSync(projectRoot).length === 0
      ? 'scaffold'
      : 'dev_local';

  const baseReport = {
    schema_version: 1 as const,
    generated_at: generatedAt.toISOString(),
    project_root: projectRoot,
    project_name: basename(projectRoot),
    markers: [...new Set(markers)].sort((left, right) => left.localeCompare(right)),
    detected_stacks: stacks.sort((left, right) => left.localeCompare(right)),
    recommended_execution_profile: recommendedProfile,
    recommended_commands: {
      install: [...new Set(commands.install)],
      build: [...new Set(commands.build)],
      test: [...new Set(commands.test)],
      lint: [...new Set(commands.lint)],
    },
    notes,
  };

  return {
    ...baseReport,
    context_draft: buildContextDraft(baseReport),
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

export function writeOnboardingReport(
  report: ProjectOnboardingReport,
  runsDir: string = BABEL_RUNS_DIR,
): string {
  const outDir = join(runsDir, 'onboarding');
  mkdirSync(outDir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const outputPath = join(outDir, `${stamp}-${slugify(report.project_name)}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return outputPath;
}
