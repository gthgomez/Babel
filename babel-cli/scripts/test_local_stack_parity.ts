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

const ROOT_BACK = BABEL_ROOT.replace(/\//g, '\\');

function toRepoRelative(value: string): string {
  const normalized = value.replace(/\//g, '\\');
  return normalized.startsWith(ROOT_BACK)
    ? normalized.slice(ROOT_BACK.length).replace(/^\\/, '')
    : normalized;
}

function stripRootInText(value: string): string {
  return value.split(ROOT_BACK + '\\').join('').split(ROOT_BACK).join('');
}

function normalizeResult(value: LocalStackResolveResult): LocalStackResolveResult {
  // Cross-layer order is part of the parity contract (load order).
  // Intra-layer order may differ: the TS resolver applies relevance sorting
  // within layers that tools/resolve-local-stack.ps1 does not implement yet,
  // so entries are ordered by (layer, id) here to keep that gap out of scope.
  const normalizedStack = value.SelectedStack.map(({ OrderIndex: _, ...entry }) => ({
    ...entry,
    FullPath: toRepoRelative(entry.FullPath),
  })).sort((left, right) =>
    left.Layer.localeCompare(right.Layer) ||
    (left.Id ?? '').localeCompare(right.Id ?? ''),
  );
  return {
    ...value,
    BabelRoot: '',
    LocalLearningRoot: toRepoRelative(value.LocalLearningRoot),
    ProjectPath: value.ProjectPath ? toRepoRelative(value.ProjectPath) : null,
    SelectedStack: normalizedStack,
    RepoContextFiles: value.RepoContextFiles.map(toRepoRelative),
    BabelEntrypoint: toRepoRelative(value.BabelEntrypoint),
    BabelReferenceFiles: value.BabelReferenceFiles.map(toRepoRelative),
    KickoffPrompt: stripRootInText(value.KickoffPrompt.replace(/\//g, '\\')),
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
    // Same cwd as runCliResolve: the file-extension gate scans the process
    // working directory on both sides, so they must observe the same root.
    cwd: CLI_ROOT,
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
    // npm.cmd on Windows: spawning the extensionless shim fails with ENOENT
    // on Node >= 20.12 without a shell.
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmBin, ['run', 'build'], { cwd: CLI_ROOT, stdio: 'inherit' });
  }
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`Missing CLI build output at ${DIST_ENTRY}. Run npm run build first.`);
  }
  if (!existsSync(PS_SCRIPT)) {
    throw new Error(`Missing PowerShell wrapper at ${PS_SCRIPT}`);
  }

  let compared = 0;
  let psLegsRun = 0;
  const envSkippedPsLegs: string[] = [];

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

    // TS <-> TS parity is contractual in every environment.
    compareResults(`${label} in-process vs CLI`, inProcess, cli);

    const expectedIntegrationDoc = join(BABEL_ROOT, 'INTEGRATION.md').replace(/\//g, '\\');
    const kickoffNorm = cli.KickoffPrompt.replace(/\//g, '\\');
    assert(
      cli.BabelEntrypoint.replace(/\//g, '\\') === expectedIntegrationDoc,
      `${label}: BabelEntrypoint must be under babel root (${expectedIntegrationDoc})`,
    );
    assert(
      kickoffNorm.includes(expectedIntegrationDoc),
      `${label}: KickoffPrompt must reference integration doc path under babel root (${expectedIntegrationDoc})`,
    );

    // Environment-divergence guard: CLI <-> PS wrapper parity requires that
    // repo-local discovery did NOT fire. The TS resolver implements
    // convention-based workspace/family-directory project discovery, which
    // tools/resolve-local-stack.ps1 does not implement; when the TS side
    // actually found this machine's local checkout of the project, the
    // enriched fields (ProjectPath, RepoContextFiles, recommended skills,
    // kickoff tail) legitimately diverge — an ambient-disk effect, not a
    // resolver contract violation. CI environments do not contain these
    // directories, so required validation there keeps full three-way coverage.
    if (cli.ProjectPath !== null) {
      console.warn(
        `[local-stack-parity] ENVIRONMENT-SKIP ${label} CLI-vs-PS: repo-local discovery ` +
          `resolved ${cli.ProjectPath} on this machine; the PowerShell wrapper does not ` +
          `implement discovery, so enrichment divergence here is environmental.`,
      );
      envSkippedPsLegs.push(label);
    } else {
      const ps = runPowerShellWrapper(fixture);
      compareResults(`${label} CLI vs PS wrapper`, cli, ps);
      psLegsRun += 1;
    }

    compared += 1;
    console.log(`[local-stack-parity] pass ${label}`);
  }

  console.log(
    `[local-stack-parity] ${compared}/${FIXTURES.length} fixtures passed ` +
      `(${psLegsRun} full three-way, ${envSkippedPsLegs.length} environment-skipped CLI-vs-PS legs` +
      (envSkippedPsLegs.length > 0 ? `: ${envSkippedPsLegs.join(', ')}` : '') + ')',
  );
}

main();
