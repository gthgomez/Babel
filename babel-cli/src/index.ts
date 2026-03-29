#!/usr/bin/env node
/**
 * index.ts — Babel CLI Entrypoint
 *
 * Usage:
 *   babel run "Fix the Stripe webhook in example_saas_backend"
 *   babel run "Add dark mode toggle" --project example_llm_router --mode verified
 *   babel run "Deploy to production" --project example_web_audit --mode autonomous
 *
 * Environment variables (set in .env at babel-cli/ root):
 *   ANTHROPIC_API_KEY     — Required for API fallback and autonomous mode.
 *   BABEL_ROOT            — Override Babel prompt library root directory.
 *   BABEL_RUNS_DIR        — Override evidence bundle output directory.
 *   BABEL_CLAUDE_CMD      — Claude CLI binary name (default: "claude").
 *   BABEL_CLAUDE_ARGS     — Claude CLI flags (default: "--print").
 *   BABEL_CLI_TIMEOUT_MS  — CLI hard timeout in ms (default: 120000).
 *   BABEL_API_MODEL       — Anthropic model ID (default: "claude-sonnet-4-6").
 *   BABEL_DRY_RUN         — Set to "false" to enable live tool execution.
 *   BABEL_SESSION_ID      — Associate raw evidence bundles with a Local Mode session ID.
 *   BABEL_SESSION_START_PATH — Exact `session-starts/...json` path for the linked Local Mode session.
 *   BABEL_LOCAL_LEARNING_ROOT — Local Mode runtime root used for protocol reconciliation.
 */

import { Command } from 'commander';
import { runBabelPipeline, resumeManualBridge } from './pipeline.js';
import { runBabelMcpServer } from './mcp/server.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log('  Babel  —  Multi-Agent OS Runtime Harness');
  console.log('  ─────────────────────────────────────────');
  console.log('');
}

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name('babel')
  .description('Babel Multi-Agent OS — local runtime harness')
  .version('1.0.0');

program
  .command('mcp')
  .description('Run the read-only Babel MCP control-plane server over stdio')
  .action(async () => {
    try {
      await runBabelMcpServer();
    } catch (err: unknown) {
      console.error(
        `[babel] MCP fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

const VALID_MODES   = ['direct', 'verified', 'autonomous', 'manual'] as const;
type ValidMode      = typeof VALID_MODES[number];

const VALID_MODELS  = ['Claude', 'Codex', 'Gemini'] as const;
type ValidModel     = typeof VALID_MODELS[number];

const VALID_PROJECTS = ['example_saas_backend', 'example_llm_router', 'example_web_audit'] as const;
type ValidProject = typeof VALID_PROJECTS[number];
const VALID_ORCHESTRATORS = ['v8', 'v9'] as const;
type ValidOrchestrator = typeof VALID_ORCHESTRATORS[number];

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BABEL_ROOT = process.env['BABEL_ROOT'] ?? resolve(__dirname, '../..');
const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');

const VALUE_OPTIONS = new Set([
  '-p', '--project',
  '--mode',
  '-m', '--model',
  '--orchestrator',
]);

function isTopLevelMetaToken(token: string): boolean {
  return token === 'help' ||
    token === '-h' ||
    token === '--help' ||
    token === '-V' ||
    token === '--version';
}

function rewriteRunArgs(argsAfterRun: string[]): string[] {
  const passthrough: string[] = [];
  const taskParts:   string[] = [];

  for (let i = 0; i < argsAfterRun.length; i++) {
    const token = argsAfterRun[i]!;

    if (VALUE_OPTIONS.has(token)) {
      passthrough.push(token);
      const value = argsAfterRun[i + 1];
      if (value !== undefined) {
        passthrough.push(value);
        i++;
      }
      continue;
    }

    if (token.startsWith('-')) {
      passthrough.push(token);
      continue;
    }

    taskParts.push(token);
  }

  if (taskParts.length === 0) {
    return ['run', ...argsAfterRun];
  }

  return ['run', ...passthrough, taskParts.join(' ')];
}

function rewriteArgv(argv: string[]): string[] {
  const head = argv.slice(0, 2);
  const tail = argv.slice(2);

  if (tail.length === 0) return argv;

  const first = tail[0]!;

  // Long form: babel run ...
  if (first === 'run') {
    return [...head, ...rewriteRunArgs(tail.slice(1))];
  }

  // Preserve top-level meta commands/options untouched.
  if (isTopLevelMetaToken(first) || first.startsWith('-')) {
    return argv;
  }

  // Shorthand: babel <Project> <task...> -> babel run --project <Project> <task...>
  if (VALID_PROJECTS.includes(first as ValidProject)) {
    return [...head, ...rewriteRunArgs(['--project', first, ...tail.slice(1)])];
  }

  return argv;
}

async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog   = console.log;
  const originalWarn  = console.warn;
  const originalError = console.error;
  console.log   = () => {};
  console.warn  = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log   = originalLog;
    console.warn  = originalWarn;
    console.error = originalError;
  }
}

function readStdinFully(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => chunks.push(Buffer.from(chunk, 'utf8')));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

function readClipboardPlanText(): string {
  if (process.platform !== 'win32') {
    throw new Error('Clipboard mode is only supported on Windows.');
  }

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
    { encoding: 'utf8' },
  );

  if (result.error) {
    throw new Error(`Clipboard read failed: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || 'Clipboard read failed.');
  }

  return result.stdout ?? '';
}

interface LatestRunPointer {
  run_dir: string;
  project: string;
  created_at: string;
}

function readLatestRunPointer(project?: string): LatestRunPointer | null {
  const scoped = project ? join(BABEL_RUNS_DIR, `.latest.${project}.json`) : null;
  const fallback = join(BABEL_RUNS_DIR, '.latest.json');
  const candidates = scoped ? [scoped, fallback] : [fallback];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as LatestRunPointer;
      if (typeof parsed.run_dir === 'string' && parsed.run_dir.length > 0) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function copyFileToClipboard(promptPath: string): { ok: boolean; warning?: string } {
  if (process.platform !== 'win32') {
    return { ok: false, warning: 'Clipboard auto-copy is only supported on Windows.' };
  }

  const psCommand =
    `Set-Clipboard -Value (Get-Content -Raw '${escapePowerShellSingleQuoted(promptPath)}')`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', psCommand],
    { encoding: 'utf8' },
  );
  if (result.error) {
    return { ok: false, warning: `Clipboard copy failed: ${result.error.message}` };
  }
  if ((result.status ?? 1) !== 0) {
    return { ok: false, warning: result.stderr?.trim() || 'Clipboard copy failed.' };
  }
  return { ok: true };
}

function openPlanEditor(planPath: string): { editor: 'code' | 'notepad' } {
  const codeResult = spawnSync(
    'code',
    ['--wait', planPath],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (!codeResult.error && (codeResult.status ?? 1) === 0) {
    return { editor: 'code' };
  }

  const notepadResult = spawnSync(
    'notepad',
    [planPath],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (notepadResult.error || (notepadResult.status ?? 0) !== 0) {
    throw new Error(
      `Editor launch failed. ` +
      `code error: ${codeResult.error?.message ?? codeResult.stderr?.toString() ?? 'unknown'}; ` +
      `notepad error: ${notepadResult.error?.message ?? notepadResult.stderr?.toString() ?? 'unknown'}`,
    );
  }
  return { editor: 'notepad' };
}

interface SmokePlanFixture {
  name: string;
  path: string;
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function findFirstSourceFile(dir: string, depth: number): string | null {
  if (depth < 0 || !existsSync(dir)) return null;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.isFile() && /\.(ts|tsx|js|jsx)$/i.test(entry.name)) {
      return join(dir, entry.name);
    }
  }

  for (const entry of sorted) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findFirstSourceFile(join(dir, entry.name), depth - 1);
    if (found) return found;
  }

  return null;
}

function findGuaranteedReadTarget(projectRoot: string): string {
  const packageJson = join(projectRoot, 'package.json');
  if (existsSync(packageJson)) return '/project/package.json';

  const srcFile = findFirstSourceFile(join(projectRoot, 'src'), 5);
  if (srcFile) {
    const relative = toPosixPath(srcFile.slice(projectRoot.length).replace(/^[/\\]+/, ''));
    return `/project/${relative}`;
  }

  const readme = join(projectRoot, 'README.md');
  if (existsSync(readme)) return '/project/README.md';

  return '/project/package.json';
}

function extractHaltTagFromExecutionReport(runDir: string): string {
  const reportPath = join(runDir, '04_execution_report.json');
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
    if (report['status'] === 'EXECUTION_COMPLETE') return 'NONE';
    if (report['status'] === 'ACTIVATION_REFUSED') {
      return String(report['gate'] ?? 'ACTIVATION_GATE_FAIL');
    }
    const pipelineError = report['pipeline_error'] as Record<string, unknown> | undefined;
    return String(pipelineError?.['halt_tag'] ?? 'UNKNOWN');
  } catch {
    return 'UNKNOWN';
  }
}

async function runManualBridgeStart(
  task: string,
  options: {
    project?: string;
    model?: string;
    sessionId?: string;
    sessionStartPath?: string;
    localLearningRoot?: string;
    orchestratorVersion?: string;
  },
): Promise<void> {
  const result = await withMutedConsole(() => runBabelPipeline(task, {
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.model !== undefined ? { modelOverride: options.model } : {}),
    ...(options.orchestratorVersion !== undefined ? { orchestratorVersion: options.orchestratorVersion as ValidOrchestrator } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
    ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
    mode: 'manual',
  }));

  if (result.status !== 'MANUAL_BRIDGE_REQUIRED' || !result.manualPromptPath) {
    throw new Error(`Manual bridge expected MANUAL_BRIDGE_REQUIRED, got ${result.status}`);
  }

  const clipboard = copyFileToClipboard(result.manualPromptPath);
  const payload: Record<string, unknown> = {
    status: 'MANUAL_BRIDGE_REQUIRED',
    run_dir: result.runDir,
    prompt_path: result.manualPromptPath,
    next: [
      'babel apply',
      'If plan.json is not ready, apply opens editor at <run_dir>/manual/plan.json.',
      'You can also run: babel apply --plan clipboard',
      'Or paste via stdin: babel apply --plan -',
    ],
  };
  if (clipboard.ok) {
    payload['clipboard'] = 'COPIED';
  } else {
    payload['clipboard'] = 'FAILED';
    payload['warning'] = clipboard.warning;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function buildSmokeFixtures(runDir: string, projectRoot: string): SmokePlanFixture[] {
  const readOnlyPath = join(runDir, 'smoke_plan_read_only.json');
  const safeWritePath = join(runDir, 'smoke_plan_safe_write.json');
  const rejectionPath = join(runDir, 'smoke_plan_sandbox_rejection.json');
  const readTarget = findGuaranteedReadTarget(projectRoot);
  const safeWriteTarget = '/project/babel_smoke_tmp.txt';

  writeJsonFile(readOnlyPath, {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify manual-bridge executor can read a guaranteed in-root file and persist memory.',
    known_facts: [
      `Target project root is ${projectRoot}`,
      `Read target for this smoke run is ${readTarget}`,
      'Chronicle memory_store tool is available in executor contract',
    ],
    assumptions: [
      'Path jail allows read-only access inside the target project root',
    ],
    risks: [
      {
        risk: 'Chosen read target could be unavailable at runtime',
        likelihood: 'low',
        mitigation: 'Use deterministic pre-discovered file path from local filesystem scan',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read deterministic smoke target file',
        tool: 'file_read',
        target: readTarget,
        rationale: 'Validate in-root file_read resolution including /project virtual mount mapping',
        reversible: true,
        verification: 'Exit code is 0 and stdout is non-empty',
      },
      {
        step: 2,
        description: 'Persist smoke fact',
        tool: 'memory_store',
        target: 'smoke-read-only',
        rationale: 'Validate Chronicle write path under executor for the selected project root',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms storage',
      },
    ],
    root_cause: 'Previous smoke failures showed /project path mapping and project-root derivation drift; this case verifies the corrected in-root read path.',
    out_of_scope: [
      'Mutating application source code',
    ],
  });

  writeJsonFile(safeWritePath, {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify manual-bridge executor can write and re-read a temp file inside the target project root.',
    known_facts: [
      `Target project root is ${projectRoot}`,
      `Write target for this smoke run is ${safeWriteTarget}`,
      'Executor contract includes file_write and file_read',
    ],
    assumptions: [
      'Writing temp file under project root is permitted',
    ],
    risks: [
      {
        risk: 'Unexpected file permissions',
        likelihood: 'low',
        mitigation: 'Use temp filename and reversible write',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Write temp smoke file inside /project mount',
        tool: 'file_write',
        target: safeWriteTarget,
        rationale: 'Validate /project to project-root mapping for file_write on Windows',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms file write',
      },
      {
        step: 2,
        description: 'Read back the temp smoke file',
        tool: 'file_read',
        target: safeWriteTarget,
        rationale: 'Confirm write landed in project root and is readable',
        reversible: true,
        verification: 'Exit code is 0 and stdout contains the written text',
      },
      {
        step: 3,
        description: 'Store write smoke result in Chronicle',
        tool: 'memory_store',
        target: 'smoke-safe-write',
        rationale: 'Track write smoke completion',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms storage',
      },
    ],
    root_cause: 'Previous smoke failures halted on /project path mapping; this case validates corrected in-root write semantics.',
    out_of_scope: [
      'Editing existing application source files',
    ],
  });

  writeJsonFile(rejectionPath, {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Confirm safety controls reject a disallowed shell_exec command in manual bridge flow.',
    known_facts: [
      'SafeExecutor enforces an explicit command allowlist',
      'shell_exec should reject commands not present in the allowlist',
    ],
    assumptions: [
      'Either QA rejects this plan as unsafe or executor halts when shell_exec is denied',
    ],
    risks: [
      {
        risk: 'Model emits different command',
        likelihood: 'medium',
        mitigation: 'Use explicit target and verification text',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Invoke shell echo to trigger sandbox command rejection',
        tool: 'shell_exec',
        target: 'echo smoke-sandbox-rejection',
        rationale: 'Intentional negative test for sandbox rejection',
        reversible: true,
        verification: 'Either QA rejects for safety OR executor halts with command rejected error',
      },
    ],
    root_cause: 'The failure mode under test is unsafe command execution; robust behavior is explicit rejection before mutation.',
    out_of_scope: [
      'Any successful code modification',
    ],
  });

  return [
    { name: 'read_only', path: readOnlyPath },
    { name: 'safe_write', path: safeWritePath },
    { name: 'sandbox_rejection', path: rejectionPath },
  ];
}

program
  .command('run')
  .argument('<task>', 'task prompt')
  .description('Run a task through the full Babel pipeline')
  .option(
    '-p, --project <name>',
    'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite)',
  )
  .option(
    '--mode <mode>',
    'Pipeline mode: direct | verified | autonomous | manual',
    'verified',
  )
  .option(
    '-m, --model <model>',
    'Override the Orchestrator and force a specific model (Claude|Codex|Gemini)',
  )
  .option(
    '--session-id <id>',
    'Associate this raw evidence bundle with a Local Mode session ID',
  )
  .option(
    '--session-start-path <path>',
    'Attach this run to an exact Local Mode session-start artifact',
  )
  .option(
    '--local-learning-root <path>',
    'Attach this run to a specific Local Mode learning root',
  )
  .option(
    '--orchestrator <version>',
    'Advanced: override orchestrator contract version (default v9)',
  )
  .action(async (
    task: string,
    options: {
      project?: string;
      mode?: string;
      model?: string;
      sessionId?: string;
      sessionStartPath?: string;
      localLearningRoot?: string;
      orchestrator?: string;
    },
  ) => {
    const mode = (options.mode ?? 'verified') as string;

    if (!VALID_MODES.includes(mode as ValidMode)) {
      console.error(
        `[babel] Invalid mode "${mode}". ` +
        `Valid values: ${VALID_MODES.join(', ')}`,
      );
      process.exit(1);
    }

    if (options.model !== undefined && !VALID_MODELS.includes(options.model as ValidModel)) {
      console.error(
        `[babel] Invalid model "${options.model}". ` +
        `Valid values: ${VALID_MODELS.join(', ')}`,
      );
      process.exit(1);
    }

    if (options.orchestrator !== undefined && !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)) {
      console.error(
        `[babel] Invalid orchestrator "${options.orchestrator}". ` +
        `Valid values: ${VALID_ORCHESTRATORS.join(', ')}`,
      );
      process.exit(1);
    }

    if (mode === 'manual') {
      try {
        await runManualBridgeStart(task, {
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
          ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
        });
        return;
      } catch (err: unknown) {
        process.stdout.write(`${JSON.stringify({
          status: 'MANUAL_BRIDGE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        }, null, 2)}\n`);
        return;
      }
    }

    printBanner();

    console.log(`[babel] Task:    ${task}`);
    console.log(`[babel] Project: ${options.project ?? '(auto-detect)'}`);
    console.log(`[babel] Mode:    ${mode}`);
    if (options.model) {
      console.log(`[babel] Model:   ${options.model} (forced override)`);
    }
    console.log(`[babel] Router:  ${options.orchestrator ?? process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9'}`);
    if (options.sessionId) {
      console.log(`[babel] Session: ${options.sessionId}`);
    }
    if (options.sessionStartPath) {
      console.log(`[babel] Session start: ${options.sessionStartPath}`);
    }
    if (options.localLearningRoot) {
      console.log(`[babel] Local root: ${options.localLearningRoot}`);
    }
    console.log('');

    try {
      // exactOptionalPropertyTypes requires absent keys, not undefined values.
      const result = await runBabelPipeline(task, {
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.model !== undefined ? { modelOverride: options.model } : {}),
        ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator as ValidOrchestrator } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
        ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
        mode: mode as ValidMode,
      });

      console.log('');
      console.log(`[babel] Status:  ${result.status}`);
      console.log(`[babel] Bundle:  ${result.runDir}`);
      console.log('');

      // Non-zero exit so CI and shell scripts can detect pipeline failures.
      if (result.status !== 'COMPLETE') {
        process.exit(1);
      }

    } catch (err: unknown) {
      console.error('');
      console.error(
        `[babel] Fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error('');
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Alias for: run --mode manual --project <project> <intent...>')
  .argument('<project>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite)')
  .argument('<intent...>', 'Task intent/prompt')
  .option(
    '--session-id <id>',
    'Associate this manual-bridge run with a Local Mode session ID',
  )
  .option(
    '--session-start-path <path>',
    'Attach this manual-bridge run to an exact Local Mode session-start artifact',
  )
  .option(
    '--local-learning-root <path>',
    'Attach this manual-bridge run to a specific Local Mode learning root',
  )
  .option(
    '--orchestrator <version>',
    'Advanced: override orchestrator contract version (default v9)',
  )
  .action(async (
    project: string,
    intent: string[],
    options: {
      sessionId?: string;
      sessionStartPath?: string;
      localLearningRoot?: string;
      orchestrator?: string;
    },
  ) => {
    const task = intent.join(' ').trim();
    if (!task) {
      process.stdout.write(`${JSON.stringify({
        status: 'PLAN_ALIAS_FAILED',
        error: 'Intent is required.',
      }, null, 2)}\n`);
      process.exit(1);
    }
    if (options.orchestrator !== undefined && !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)) {
      process.stdout.write(`${JSON.stringify({
        status: 'PLAN_ALIAS_FAILED',
        error: `Invalid orchestrator "${options.orchestrator}". Valid values: ${VALID_ORCHESTRATORS.join(', ')}`,
      }, null, 2)}\n`);
      process.exit(1);
    }
    try {
      await runManualBridgeStart(task, {
        project,
        ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
        ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
      });
    } catch (err: unknown) {
      process.stdout.write(`${JSON.stringify({
        status: 'PLAN_ALIAS_FAILED',
        error: err instanceof Error ? err.message : String(err),
      }, null, 2)}\n`);
      process.exit(1);
    }
  });

async function handleResumeCommand(
  options: { run?: string; plan?: string; project?: string },
): Promise<void> {
  let resolvedRun = options.run;
  if (!resolvedRun) {
    const latest = readLatestRunPointer(options.project);
    if (!latest) {
      process.stdout.write(`${JSON.stringify({
        status: 'NO_LATEST_RUN',
        how_to: [
          'babel plan example_llm_router "..."',
          'babel run --project example_llm_router "..."',
        ],
      }, null, 2)}\n`);
      return;
    }
    resolvedRun = latest.run_dir;
  }

  try {
    const autoDiscoveredPath = join(resolvedRun, 'manual', 'plan.json');
    let result;

    if (options.plan === undefined) {
      if (!existsSync(autoDiscoveredPath)) {
        mkdirSync(join(resolvedRun, 'manual'), { recursive: true });
        writeFileSync(autoDiscoveredPath, '{\n}\n', 'utf-8');
        const editor = openPlanEditor(autoDiscoveredPath);
        const rawPlanText = readFileSync(autoDiscoveredPath, 'utf-8');
        result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
        if (result.status === 'MANUAL_PLAN_INVALID') {
          process.stdout.write(`${JSON.stringify({
            status: 'MANUAL_PLAN_INVALID',
            run_dir: result.runDir,
            plan_path: autoDiscoveredPath,
            editor: editor.editor,
            repair_prompt_path: result.repairPromptPath,
            errors: result.errors ?? [],
          }, null, 2)}\n`);
          return;
        }
      } else {
        result = await withMutedConsole(() => resumeManualBridge(resolvedRun, autoDiscoveredPath));
      }
    } else if (options.plan === '-') {
      const rawPlanText = await readStdinFully();
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
    } else if (options.plan.toLowerCase() === 'clipboard') {
      const rawPlanText = readClipboardPlanText();
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
    } else {
      const planPath = options.plan;
      if (!planPath) {
        throw new Error('Plan path is required.');
      }
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, planPath));
    }

    if (result.status === 'MANUAL_PLAN_INVALID') {
      process.stdout.write(`${JSON.stringify({
        status: 'MANUAL_PLAN_INVALID',
        run_dir: result.runDir,
        repair_prompt_path: result.repairPromptPath,
        errors: result.errors ?? [],
      }, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify({
      status: result.status,
      run_dir: result.runDir,
    }, null, 2)}\n`);

    if (result.status !== 'COMPLETE') {
      process.exit(1);
    }
  } catch (err: unknown) {
    process.stdout.write(`${JSON.stringify({
      status: 'MANUAL_RESUME_FAILED',
      run_dir: resolvedRun,
      error: err instanceof Error ? err.message : String(err),
    }, null, 2)}\n`);
    process.exit(1);
  }
}

program
  .command('resume')
  .description('Resume a manual bridge run from a validated plan.json file')
  .option('--run <run_dir>', 'Existing Babel run directory path')
  .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
  .option('--plan <path>', 'Path to manual plan.json, "-" for stdin, or "clipboard"')
  .action(async (options: { run?: string; plan?: string; project?: string }) => {
    await handleResumeCommand(options);
  });

program
  .command('apply')
  .description('Alias for resume')
  .option('--run <run_dir>', 'Existing Babel run directory path')
  .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
  .option('--plan <path>', 'Path to manual plan.json, "-" for stdin, or "clipboard"')
  .action(async (options: { run?: string; plan?: string; project?: string }) => {
    await handleResumeCommand(options);
  });

async function handleSmokeCommand(options: { project: string }): Promise<void> {
  try {
    const task = 'Manual Bridge smoke test: validate executor robustness with fixture plans.';

    const manualResult = await withMutedConsole(() => runBabelPipeline(task, {
      project: options.project,
      mode: 'manual',
    }));

    if (manualResult.status !== 'MANUAL_BRIDGE_REQUIRED' || !manualResult.manualPromptPath) {
      throw new Error(`Manual start failed with status ${manualResult.status}`);
    }

    const runDir = manualResult.runDir;
    const projectRoot = manualResult.manifest.target_project_path ?? process.env['BABEL_PROJECT_ROOT'];
    if (!projectRoot) {
      throw new Error('Unable to resolve project root for smoke fixtures.');
    }
    const fixtures = buildSmokeFixtures(runDir, projectRoot);
    const cases: Array<{ name: string; status: 'PASS' | 'HALT'; halt_tag: string }> = [];

    for (const fixture of fixtures) {
      const maxAttempts = fixture.name === 'sandbox_rejection' ? 1 : 3;
      let resumed = await withMutedConsole(() => resumeManualBridge(runDir, fixture.path));
      let haltTag = extractHaltTagFromExecutionReport(runDir);

      if (fixture.name !== 'sandbox_rejection') {
        for (let attempt = 2; attempt <= maxAttempts; attempt++) {
          const shouldRetry =
            (resumed.status === 'QA_REJECTED_MAX_LOOPS') ||
            (resumed.status === 'COMPLETE' && (haltTag === 'ACTIVATION_GATE_FAIL' || haltTag === 'UNKNOWN'));
          if (!shouldRetry) break;
          resumed = await withMutedConsole(() => resumeManualBridge(runDir, fixture.path));
          haltTag = extractHaltTagFromExecutionReport(runDir);
        }
      }

      if (fixture.name === 'sandbox_rejection') {
        if (resumed.status === 'QA_REJECTED_MAX_LOOPS') {
          cases.push({ name: fixture.name, status: 'PASS', halt_tag: 'QA_REJECTED_EXPECTED' });
          continue;
        }
        if (resumed.status === 'COMPLETE' && haltTag === 'STEP_VERIFICATION_FAIL') {
          cases.push({ name: fixture.name, status: 'PASS', halt_tag: haltTag });
          continue;
        }
        if (resumed.status === 'MANUAL_PLAN_INVALID') {
          cases.push({ name: fixture.name, status: 'HALT', halt_tag: 'MANUAL_PLAN_INVALID' });
          continue;
        }
        cases.push({ name: fixture.name, status: 'HALT', halt_tag: resumed.status });
        continue;
      }

      if (resumed.status === 'COMPLETE') {
        if (haltTag === 'NONE') {
          cases.push({ name: fixture.name, status: 'PASS', halt_tag: 'NONE' });
        } else {
          cases.push({ name: fixture.name, status: 'HALT', halt_tag: haltTag });
        }
      } else if (resumed.status === 'MANUAL_PLAN_INVALID') {
        cases.push({ name: fixture.name, status: 'HALT', halt_tag: 'MANUAL_PLAN_INVALID' });
      } else {
        cases.push({ name: fixture.name, status: 'HALT', halt_tag: resumed.status });
      }
    }

    process.stdout.write(`${JSON.stringify({
      status: 'SMOKE_COMPLETE',
      project: options.project,
      run_dir: runDir,
      manual_prompt_path: manualResult.manualPromptPath,
      cases,
    }, null, 2)}\n`);
  } catch (err: unknown) {
    process.stdout.write(`${JSON.stringify({
      status: 'SMOKE_FAILED',
      error: err instanceof Error ? err.message : String(err),
    }, null, 2)}\n`);
  }
}

program
  .command('smoke')
  .description('Run Manual Bridge smoke suite and summarize executor outcomes')
  .requiredOption('--project <name>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite)')
  .action(async (options: { project: string }) => {
    await handleSmokeCommand(options);
  });

program
  .command('test')
  .description('Alias for smoke')
  .option('--project <name>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite)')
  .argument('[project]', 'Target project')
  .action(async (projectArg: string | undefined, options: { project?: string }) => {
    const project = options.project ?? projectArg;
    if (!project) {
      process.stdout.write(`${JSON.stringify({
        status: 'TEST_ALIAS_FAILED',
        error: 'Project is required. Use --project <name> or positional project.',
      }, null, 2)}\n`);
      process.exit(1);
    }
    await handleSmokeCommand({ project });
  });

program.parse(rewriteArgv(process.argv));

