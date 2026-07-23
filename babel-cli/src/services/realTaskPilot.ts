import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';

export interface RealTaskPilotOptions {
  projectRoot?: string;
  outputDir?: string;
  now?: Date;
}

export interface RealTaskPilotCase {
  id: string;
  purpose: string;
  command: string;
  risk: 'read_only' | 'low' | 'medium';
  success_signal: string[];
}

export interface RealTaskPilotReport {
  schema_version: 1;
  report_type: 'babel_real_task_pilot';
  generated_at: string;
  project_root: string;
  artifact_path: string;
  repo: {
    name: string;
    package_json: boolean;
    test_command: string | null;
    dirty_files: string[];
  };
  cases: RealTaskPilotCase[];
  next: string[];
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function readPackageTestCommand(projectRoot: string): string | null {
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.['test'] === 'string' ? 'npm test' : null;
  } catch {
    return null;
  }
}

function readDirtyFiles(projectRoot: string): string[] {
  const result = spawnSync('git', ['status', '--short'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildCases(
  projectRoot: string,
  testCommand: string | null,
  dirtyFiles: string[],
): RealTaskPilotCase[] {
  const rootArg = `--project-root ${quote(projectRoot)}`;
  const verifier = testCommand ?? 'your normal test command';
  const dirtyNote =
    dirtyFiles.length > 0
      ? 'Confirm Babel preserves existing dirty files and only changes files named by the task.'
      : 'Confirm Babel does not create unrelated dirty files.';

  return [
    {
      id: 'read_only_failure_explanation',
      purpose:
        'Check whether the daily ask lane can inspect real project context without leaking internal run language.',
      command: `babel ask ${quote('Explain the most likely local test command and any obvious setup risks without editing.')} ${rootArg}`,
      risk: 'read_only',
      success_signal: [
        'No files changed',
        'Answer names concrete repo evidence',
        'Output is understandable without JSON',
      ],
    },
    {
      id: 'ambiguous_task_triage',
      purpose: 'Check whether do chooses ask/plan/fix sensibly when the user request is fuzzy.',
      command: `babel do ${quote('Why is this project hard to test locally? Do not edit files.')} ${rootArg}`,
      risk: 'read_only',
      success_signal: [
        'selected path is read-only in JSON, or human output clearly says no edits',
        'No files changed',
      ],
    },
    {
      id: 'one_file_real_fix',
      purpose: 'Run one tightly scoped real fix after manually choosing a safe target file.',
      command: `babel fix ${quote(`Fix one small failing test. Only edit <relative-file>. Run ${verifier} before completing.`)} ${rootArg} --execution-profile dev_local`,
      risk: 'low',
      success_signal: ['One intended file changed', `${verifier} passed`, dirtyNote],
    },
    {
      id: 'multi_file_verified_stress',
      purpose: 'Exercise the broader verified pipeline on a bounded two-to-three-file change.',
      command: `babel run ${quote(`Make a bounded two-file cleanup. Name the files explicitly. Run ${verifier} before completing.`)} ${rootArg} --mode deep --execution-profile dev_local`,
      risk: 'medium',
      success_signal: [
        'Plan names exact files before writes',
        'No unrelated files changed',
        `${verifier} or explicit verifier result recorded`,
      ],
    },
    {
      id: 'recovery_drill',
      purpose:
        'Prove continue/resume are legible after a real verifier failure or provider interruption.',
      command: 'babel continue latest && babel resume latest',
      risk: 'read_only',
      success_signal: [
        'continue explains the next step',
        'resume acts only when retryable',
        'available artifacts point to real files',
      ],
    },
  ];
}

export function buildRealTaskPilotReport(options: RealTaskPilotOptions = {}): RealTaskPilotReport {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const outputDir = resolve(
    options.outputDir ??
      join(BABEL_RUNS_DIR, 'benchmarks', `real-task-pilot-${formatTimestamp(now)}`),
  );
  mkdirSync(outputDir, { recursive: true });
  const testCommand = readPackageTestCommand(projectRoot);
  const dirtyFiles = readDirtyFiles(projectRoot);
  const report: RealTaskPilotReport = {
    schema_version: 1,
    report_type: 'babel_real_task_pilot',
    generated_at: now.toISOString(),
    project_root: projectRoot,
    artifact_path: join(outputDir, 'report.json'),
    repo: {
      name: basename(projectRoot),
      package_json: existsSync(join(projectRoot, 'package.json')),
      test_command: testCommand,
      dirty_files: dirtyFiles,
    },
    cases: buildCases(projectRoot, testCommand, dirtyFiles),
    next: [
      'Run the read-only cases first.',
      'Pick one safe real bug for one_file_real_fix and replace <relative-file> before running it.',
      'Run the multi-file stress case only after the one-file fix succeeds.',
      'Score each run on command clarity, correct path selection, edit scope, verifier evidence, and recovery clarity.',
    ],
  };
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

export function formatRealTaskPilotHuman(report: RealTaskPilotReport): string {
  const lines = [
    'Babel Real-Task Pilot',
    `Project: ${report.project_root}`,
    `Test command: ${report.repo.test_command ?? '(not detected)'}`,
    `Dirty files: ${report.repo.dirty_files.length}`,
    '',
    'Pilot cases:',
  ];
  for (const testCase of report.cases) {
    lines.push(`- ${testCase.id} [${testCase.risk}]: ${testCase.purpose}`);
    lines.push(`  ${testCase.command}`);
  }
  lines.push('');
  lines.push('Next:');
  for (const step of report.next) {
    lines.push(`- ${step}`);
  }
  lines.push('');
  lines.push(`Report: ${report.artifact_path}`);
  return lines.join('\n');
}
