import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../src/cli/constants.js';
import {
  readParityCorpusTask,
  resolveBabelCliEntry,
  writeParityCorpusRepo,
} from '../src/services/parityCorpus.js';
import { runBabelCli } from '../src/services/liteTrustDemo.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RELIC_RUN = '/tmp/example_game_suite\\relicRun';

dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

type ProviderMode = 'live' | 'mock';

interface DiscoveryScenario {
  id: string;
  target: 'seeded' | 'relicrun';
  description: string;
  command: string[];
  acceptableStatuses: string[];
  allowBlocked?: boolean;
  readOnly?: boolean;
}

interface ScenarioResult {
  id: string;
  target: string;
  status: 'pass' | 'fail' | 'skip';
  exit_code: number;
  reported_status: string | null;
  run_dir: string | null;
  latency_ms: number;
  notes: string[];
  stdout_path: string;
  stderr_path: string;
}

interface CliOptions {
  provider: ProviderMode;
  relicRunPath: string;
  evidenceDir?: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run test:live-lite-discovery -- [options]',
    '',
    'Run Lite discovery scenarios on seeded fixtures and relicRun.',
    '',
    'Options:',
    '  --provider <mode>     live | mock (default: mock)',
    '  --relic-run <path>    relicRun project root',
    '  --evidence-dir <path> Evidence root (default: runs/live-lite-discovery)',
    '  --json                Emit structured JSON report only',
    '  --help                Show this help',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    provider: 'mock',
    relicRunPath: DEFAULT_RELIC_RUN,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--provider') {
      const provider = readValue(argv, ++index, '--provider');
      if (provider !== 'live' && provider !== 'mock') {
        throw new Error('--provider must be live or mock');
      }
      options.provider = provider;
      continue;
    }
    if (arg === '--relic-run') {
      options.relicRunPath = readValue(argv, ++index, '--relic-run');
      continue;
    }
    if (arg === '--evidence-dir') {
      options.evidenceDir = readValue(argv, ++index, '--evidence-dir');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function hasLiveProviderKey(): boolean {
  return Boolean(process.env['DEEPSEEK_API_KEY'] || process.env['DEEPINFRA_API_KEY']);
}

const INTERNAL_VERBS = new Set(['daily', 'plan', 'undo', 'review']);

function taskTextFromArgv(argv: string[]): string {
  return argv
    .filter((arg) => !arg.startsWith('-') && !INTERNAL_VERBS.has(arg))
    .join(' ');
}

function wantsMutationProvider(argv: string[]): boolean {
  const head = argv[0];
  if (head === 'plan' || head === 'review' || head === 'undo') {
    return false;
  }
  if (head === 'daily') {
    return /\b(fix|repair)\b/i.test(taskTextFromArgv(argv));
  }
  return false;
}

function buildScenarios(): DiscoveryScenario[] {
  return [
    {
      id: 'ask_concrete',
      target: 'seeded',
      description: 'Grounded read-only ask on seeded repo',
      command: ['daily', '--json', 'what test command should I run?'],
      acceptableStatuses: ['ANSWER_READY', 'REPORT_READY'],
      readOnly: true,
    },
    {
      id: 'ask_vague',
      target: 'seeded',
      description: 'Vague discovery ask on seeded repo',
      command: ['daily', '--json', 'what is this project?'],
      acceptableStatuses: ['ANSWER_READY', 'REPORT_READY', 'NEEDS_MORE_CONTEXT'],
      allowBlocked: true,
      readOnly: true,
    },
    {
      id: 'plan_concrete',
      target: 'seeded',
      description: 'Concrete plan with grounding',
      command: ['plan', '--json', 'add a health check script'],
      acceptableStatuses: ['PLAN_READY', 'NEEDS_MORE_CONTEXT'],
      allowBlocked: true,
      readOnly: true,
    },
    {
      id: 'plan_vague_relicrun',
      target: 'relicrun',
      description: 'Vague roadmap plan on relicRun (repro case)',
      command: ['plan', '--json', 'help me plan next features'],
      acceptableStatuses: ['PLAN_READY', 'NEEDS_MORE_CONTEXT'],
      allowBlocked: true,
      readOnly: true,
    },
    {
      id: 'do_vague_readonly_relicrun',
      target: 'relicrun',
      description: 'Vague read-only do routing on relicRun',
      command: ['daily', '--json', 'why is testing hard here? do not edit files'],
      acceptableStatuses: ['ANSWER_READY', 'PLAN_READY', 'REPORT_READY', 'PROPOSAL_READY', 'PATCH_READY', 'NEEDS_MORE_CONTEXT', 'READ_ONLY_NO_MODIFICATION'],
      allowBlocked: true,
      readOnly: true,
    },
    {
      id: 'do_vague_fix',
      target: 'seeded',
      description: 'Vague fix routing on seeded repo',
      command: ['daily', '--json', 'fix failing tests'],
      acceptableStatuses: ['FIX_COMPLETE', 'SMALL_FIX_COMPLETE', 'DO_COMPLETE'],
      readOnly: false,
    },
    {
      id: 'fix_scoped',
      target: 'seeded',
      description: 'Scoped fix on seeded math bug',
      command: ['daily', '--json', 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.'],
      acceptableStatuses: ['FIX_COMPLETE', 'SMALL_FIX_COMPLETE'],
      readOnly: false,
    },
    {
      id: 'propose_scoped',
      target: 'seeded',
      description: 'Proposal lane on seeded repo',
      command: ['daily', '--json', 'propose the smallest diff to fix the math test without applying'],
      acceptableStatuses: ['PROPOSAL_READY', 'PATCH_READY', 'PATCH_COMPLETE', 'PLAN_READY'],
      readOnly: true,
    },
    {
      id: 'report_via_do',
      target: 'seeded',
      description: 'Report routing via daily task',
      command: ['daily', '--json', 'compare test setup risks without editing files'],
      acceptableStatuses: ['REPORT_READY', 'ANSWER_READY', 'NEEDS_MORE_CONTEXT', 'PLAN_READY'],
      allowBlocked: true,
      readOnly: true,
    },
    {
      id: 'review_after_fix',
      target: 'seeded',
      description: 'Review after fix on seeded repo',
      command: ['review', '--json'],
      acceptableStatuses: ['REVIEW_READY', 'REVIEW_COMPLETE', 'READ_ONLY_NO_MODIFICATION'],
      readOnly: true,
    },
    {
      id: 'undo_after_fix',
      target: 'seeded',
      description: 'Undo after fix on seeded repo',
      command: ['undo', '--json'],
      acceptableStatuses: ['UNDO_COMPLETE'],
      readOnly: true,
    },
  ];
}

function runDiscoveryCli(
  args: string[],
  projectRoot: string,
  provider: ProviderMode,
  cliEntry: string,
): ReturnType<typeof runBabelCli> {
  const argv = [...args];
  if (!argv.includes('--project-root')) {
    argv.push('--project-root', projectRoot);
  }
  if (!argv.includes('--provider') && wantsMutationProvider(argv)) {
    const insertAt = argv[0] === 'daily' ? 1 : 0;
    argv.splice(insertAt + 1, 0, '--provider', provider);
  }
  return runBabelCli(argv, {
    projectRoot,
    cliEntry,
    offlineDemo: provider === 'mock',
  });
}

function evaluateScenario(
  scenario: DiscoveryScenario,
  cli: ReturnType<typeof runBabelCli>,
): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  const payload = cli.payload;
  const reported = typeof payload?.['status'] === 'string' ? payload['status'] : null;
  const humanBlob = `${cli.stdout}\n${cli.stderr}`;
  if (/Zod validation failed|LITE_SCHEMA_FAILED/i.test(humanBlob)) {
    notes.push('schema failure surfaced in CLI output');
    return { pass: false, notes };
  }
  if (cli.exitCode !== 0 && reported === null) {
    notes.push(`cli exit=${cli.exitCode} without structured status`);
    if (cli.stderr.trim().length > 0) {
      notes.push(cli.stderr.trim().split('\n')[0] ?? 'stderr present');
    }
    return { pass: false, notes };
  }
  if (scenario.acceptableStatuses.includes(reported ?? '')) {
    notes.push(`status=${reported}`);
    return { pass: true, notes };
  }
  if (scenario.allowBlocked === true && reported === 'NEEDS_MORE_CONTEXT') {
    notes.push('acceptable blocked status NEEDS_MORE_CONTEXT');
    return { pass: true, notes };
  }
  notes.push(`unexpected status=${String(reported)}, exit=${cli.exitCode}`);
  return { pass: false, notes };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.provider === 'live' && !hasLiveProviderKey()) {
    throw new Error('Live discovery requires DEEPSEEK_API_KEY or DEEPINFRA_API_KEY.');
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'live-lite-discovery', timestamp));
  mkdirSync(evidenceDir, { recursive: true });

  const seededRoot = mkdtempSync(join(tmpdir(), 'babel-lite-discovery-seeded-'));
  const task = readParityCorpusTask('small_bug_fix');
  writeParityCorpusRepo(seededRoot, task);
  writeFileSync(join(seededRoot, 'README.md'), '# Discovery Fixture\nA tiny Node math repo for Lite discovery.\n', 'utf-8');

  const relicRunPath = resolve(options.relicRunPath);
  const relicRunExists = existsSync(relicRunPath);
  const cliEntry = resolveBabelCliEntry();
  const results: ScenarioResult[] = [];

  try {
    for (const scenario of buildScenarios()) {
      if (scenario.target === 'relicrun' && !relicRunExists) {
        results.push({
          id: scenario.id,
          target: relicRunPath,
          status: 'skip',
          exit_code: 0,
          reported_status: null,
          run_dir: null,
          latency_ms: 0,
          notes: [`relicRun path missing: ${relicRunPath}`],
          stdout_path: '',
          stderr_path: '',
        });
        continue;
      }

      const projectRoot = scenario.target === 'relicrun' ? relicRunPath : seededRoot;
      const started = performance.now();
      const scenarioDir = join(evidenceDir, scenario.id);
      mkdirSync(scenarioDir, { recursive: true });

      const cli = runDiscoveryCli(
        scenario.command,
        projectRoot,
        options.provider,
        cliEntry,
      );
      const stdoutPath = join(scenarioDir, 'stdout.log');
      const stderrPath = join(scenarioDir, 'stderr.log');
      writeFileSync(stdoutPath, cli.stdout, 'utf-8');
      writeFileSync(stderrPath, cli.stderr, 'utf-8');

      const evaluation = evaluateScenario(scenario, cli);
      const reported = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
      const runDir = typeof cli.payload?.['run_dir'] === 'string' ? cli.payload['run_dir'] : null;

      results.push({
        id: scenario.id,
        target: projectRoot,
        status: evaluation.pass ? 'pass' : 'fail',
        exit_code: cli.exitCode,
        reported_status: reported,
        run_dir: runDir,
        latency_ms: Math.round(performance.now() - started),
        notes: [...evaluation.notes, scenario.description],
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      });
    }
  } finally {
    rmSync(seededRoot, { recursive: true, force: true });
  }

  const summary = {
    schema_version: 1,
    report_type: 'babel_live_lite_discovery',
    generated_at: new Date().toISOString(),
    provider: options.provider,
    relic_run_path: relicRunPath,
    relic_run_present: relicRunExists,
    evidence_dir: evidenceDir,
    totals: {
      pass: results.filter(entry => entry.status === 'pass').length,
      fail: results.filter(entry => entry.status === 'fail').length,
      skip: results.filter(entry => entry.status === 'skip').length,
    },
    results,
  };
  const reportPath = join(evidenceDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`Live Lite discovery (${options.provider})\n`);
    process.stdout.write(`Evidence: ${evidenceDir}\n`);
    for (const entry of results) {
      process.stdout.write(`- ${entry.id}: ${entry.status} (${entry.reported_status ?? 'n/a'})\n`);
    }
    process.stdout.write(`Pass ${summary.totals.pass}/${results.length - summary.totals.skip} (skipped ${summary.totals.skip})\n`);
  }

  if (summary.totals.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});