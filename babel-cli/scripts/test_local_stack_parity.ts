import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocalStack } from '../src/control-plane/localStackResolver.js';
import type {
  LocalModel,
  LocalPipelineMode,
  LocalProject,
  LocalStackResolveResult,
  LocalTaskCategory,
} from '../src/control-plane/localStackResolver.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const BABEL_ROOT = resolve(CLI_ROOT, '..');
const DIST_ENTRY = join(CLI_ROOT, 'dist', 'index.js');
const PS_SCRIPT = join(BABEL_ROOT, 'tools', 'resolve-local-stack.ps1');
const ENV_FILE = join(CLI_ROOT, '.env');

interface Fixture {
  taskCategory: LocalTaskCategory;
  project: LocalProject;
  model: string;
  pipelineMode: LocalPipelineMode;
  taskOverlayIds?: string[];
  taskPrompt?: string;
  purposeMode?: string;
  disableRecommendedTaskOverlays?: boolean;
  loadAllSkills?: boolean;
}

const FIXTURES: Fixture[] = [
  { taskCategory: 'frontend', project: 'global', model: 'codex', pipelineMode: 'chat' },
  { taskCategory: 'backend', project: 'example_saas_backend', model: 'codex', pipelineMode: 'deep' },
  { taskCategory: 'compliance', project: 'AuditGuard', model: 'claude', pipelineMode: 'chat' },
  { taskCategory: 'mobile', project: 'Project_Android', model: 'gemini', pipelineMode: 'deep' },
  { taskCategory: 'game', project: 'godot_td', model: 'codex', pipelineMode: 'chat' },
  { taskCategory: 'research', project: 'global', model: 'codex', pipelineMode: 'deep' },
  { taskCategory: 'frontend', project: 'global', model: 'CODEX', pipelineMode: 'chat' },
];

function normalizeModel(model: string): LocalModel {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
    return normalized;
  }
  throw new Error(`Unsupported fixture model "${model}"`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeResult(value: LocalStackResolveResult): LocalStackResolveResult {
  return {
    ...value,
    ProjectPath: value.ProjectPath ? value.ProjectPath.replace(/\//g, '\\') : null,
    SelectedStack: value.SelectedStack.map(({ OrderIndex: _, ...entry }) => ({
      ...entry,
      FullPath: entry.FullPath.replace(/\//g, '\\'),
    })),
    RepoContextFiles: value.RepoContextFiles.map(path => path.replace(/\//g, '\\')),
    BabelEntrypoint: value.BabelEntrypoint.replace(/\//g, '\\'),
    BabelReferenceFiles: value.BabelReferenceFiles.map(path => path.replace(/\//g, '\\')),
    KickoffPrompt: value.KickoffPrompt.replace(/\//g, '\\'),
  };
}

function runCliResolve(fixture: Fixture): LocalStackResolveResult {
  const args = [
    ...(existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : []),
    DIST_ENTRY,
    'resolve',
    '--task-category', fixture.taskCategory,
    '--project', fixture.project,
    '--model', fixture.model,
    '--pipeline-mode', fixture.pipelineMode,
    '--babel-root', BABEL_ROOT,
    '--json',
  ];
  if (fixture.taskOverlayIds?.length) {
    for (const overlay of fixture.taskOverlayIds) {
      args.push('--task-overlay-id', overlay);
    }
  }
  if (fixture.taskPrompt) {
    args.push('--task-prompt', fixture.taskPrompt);
  }
  if (fixture.purposeMode) {
    args.push('--purpose-mode', fixture.purposeMode);
  }
  if (fixture.disableRecommendedTaskOverlays === true) {
    args.push('--disable-recommended-task-overlays');
  }
  if (fixture.loadAllSkills === true) {
    args.push('--load-all-skills');
  }
  const stdout = execFileSync(process.execPath, args, {
    cwd: CLI_ROOT,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as LocalStackResolveResult;
}

function runPowerShellWrapper(fixture: Fixture): LocalStackResolveResult {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', PS_SCRIPT,
    '-TaskCategory', fixture.taskCategory,
    '-Project', fixture.project,
    '-Model', fixture.model,
    '-PipelineMode', fixture.pipelineMode,
    '-Root', BABEL_ROOT,
    '-Json',
  ];
  if (fixture.taskOverlayIds?.length) {
    args.push('-TaskOverlayIds', ...fixture.taskOverlayIds);
  }
  if (fixture.taskPrompt) {
    args.push('-TaskPrompt', fixture.taskPrompt);
  }
  if (fixture.purposeMode) {
    args.push('-PurposeMode', fixture.purposeMode);
  }
  if (fixture.disableRecommendedTaskOverlays === true) {
    args.push('-DisableRecommendedTaskOverlays');
  }
  if (fixture.loadAllSkills === true) {
    args.push('-LoadAllSkills');
  }

  const stdout = execFileSync('pwsh', args, {
    cwd: BABEL_ROOT,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as LocalStackResolveResult;
}

function compareResults(
  label: string,
  left: LocalStackResolveResult,
  right: LocalStackResolveResult,
): void {
  const leftJson = JSON.stringify(normalizeResult(left));
  const rightJson = JSON.stringify(normalizeResult(right));
  if (leftJson !== rightJson) {
    throw new Error(`${label} mismatch:\nleft=${leftJson}\nright=${rightJson}`);
  }
}

function main(): void {
  if (!existsSync(DIST_ENTRY)) {
    execFileSync('npm', ['run', 'build'], { cwd: CLI_ROOT, stdio: 'inherit' });
  }
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`Missing CLI build output at ${DIST_ENTRY}. Run npm run build first.`);
  }
  if (!existsSync(PS_SCRIPT)) {
    throw new Error(`Missing PowerShell wrapper at ${PS_SCRIPT}`);
  }

  for (const fixture of FIXTURES) {
    const label = `${fixture.taskCategory}/${fixture.project}/${fixture.model}/${fixture.pipelineMode}`;
    const normalizedModel = normalizeModel(fixture.model);
    const inProcess = resolveLocalStack({
      taskCategory: fixture.taskCategory,
      project: fixture.project,
      model: normalizedModel,
      pipelineMode: fixture.pipelineMode,
      ...(fixture.taskOverlayIds ? { taskOverlayIds: fixture.taskOverlayIds } : {}),
      ...(fixture.taskPrompt ? { taskPrompt: fixture.taskPrompt } : {}),
      ...(fixture.purposeMode ? { purposeMode: fixture.purposeMode as never } : {}),
      ...(fixture.disableRecommendedTaskOverlays ? { disableRecommendedTaskOverlays: true } : {}),
      ...(fixture.loadAllSkills ? { loadAllSkills: true } : {}),
      babelRoot: BABEL_ROOT,
    });
    const cli = runCliResolve(fixture);
    const ps = runPowerShellWrapper(fixture);

    compareResults(`${label} in-process vs CLI`, inProcess, cli);
    compareResults(`${label} CLI vs PS wrapper`, cli, ps);

    const expectedBible = join(BABEL_ROOT, 'BABEL_BIBLE.md').replace(/\//g, '\\');
    const kickoffNorm = cli.KickoffPrompt.replace(/\//g, '\\');
    assert(
      cli.BabelEntrypoint.replace(/\//g, '\\') === expectedBible,
      `${label}: BabelEntrypoint must be under babel root (${expectedBible})`,
    );
    assert(
      kickoffNorm.includes(expectedBible),
      `${label}: KickoffPrompt must reference bible path under babel root (${expectedBible})`,
    );

    console.log(`[local-stack-parity] pass ${label}`);
  }

  console.log(`[local-stack-parity] ${FIXTURES.length}/${FIXTURES.length} fixtures passed`);
}

main();
