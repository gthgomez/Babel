/**
 * SWE-A remeasure helper with asymmetric diff critic enabled.
 *
 * Usage:
 *   # Offline A09-class acceptance (no API keys):
 *   npx tsx scripts/remeasure_swe_a_with_critic.ts --a09-acceptance
 *
 *   # Live single cell (requires DEEPSEEK_API_KEY + datasets):
 *   npx tsx scripts/remeasure_swe_a_with_critic.ts --task SWE-A09
 *
 *   # Live SWE-A breadth (A01–A10):
 *   npx tsx scripts/remeasure_swe_a_with_critic.ts --tier A_daily --all-swe
 *
 * Forces BABEL_HEADLESS=1 and BABEL_DIFF_CRITIC=1 so the pre-completion
 * critic runs. Writes a rollup under runs/agent-benchmark-critic-remeasure/.
 */

import { config as dotenvConfig } from 'dotenv';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..');
dotenvConfig({ path: join(packageRoot, '.env'), override: true, quiet: true });

/** P0: live cells spawn dist — rebuild when source is newer (BABEL_CLI_DIST_GATE). */
async function ensureDistBeforeLive(): Promise<void> {
  const { ensureBabelCliDistReady } = await import('../src/services/liteTrustDemo.js');
  ensureBabelCliDistReady({ packageRoot, mode: 'ensure' });
}

interface Args {
  a09Acceptance: boolean;
  task: string;
  allSwe: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    a09Acceptance: false,
    task: '',
    allSwe: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--a09-acceptance') args.a09Acceptance = true;
    else if (a === '--all-swe') args.allSwe = true;
    else if (a === '--task') args.task = argv[++i] ?? '';
    else if (a === '--tier') {
      // accepted for forward-compat with run_agent_benchmark flags; ignored here
      i++;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm --prefix .\\babel-cli run benchmark:agent:critic -- [options]',
      '',
      '  --a09-acceptance   Run offline A09-class critic fixture tests (no API)',
      '  --task <id>        Live remeasure one task (e.g. SWE-A09)',
      '  --all-swe          Live remeasure SWE-A01..A10 sequentially',
      '  --help             Show help',
      '',
      'Env:',
      '  BABEL_DIFF_CRITIC=1 (forced)',
      '  BABEL_HEADLESS=1 (forced)',
      '  BABEL_DIFF_CRITIC_MODEL (default deepseek-v4-flash)',
      '  BABEL_CLI_DIST_GATE=ensure|fail|warn|off (default ensure on live)',
      '  BABEL_CLI_ENTRY=path (optional override; skips dist gate)',
      '  BABEL_CHAT_MAX_WALL_MS (optional; omit to use general_swe 600s)',
      '  DEEPSEEK_API_KEY for live cells',
      '',
    ].join('\n'),
  );
}

/** Offline gate: unit tests that encode A09 wrong/gold critic acceptance. */
function runA09Acceptance(): number {
  process.stdout.write('Running offline A09-class critic acceptance (node:test)…\n');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'src/agent/diffCritic.test.ts',
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env },
      stdio: 'inherit',
    },
  );
  return result.status ?? 1;
}

function ensureEvidenceDir(): string {
  const dir = join(repoRoot, 'runs', 'agent-benchmark-critic-remeasure');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runLiveTask(taskId: string, evidenceDir: string): {
  task: string;
  exitCode: number;
  reportPath: string | null;
  criticVerdict: string | null;
  status: string | null;
  correct: boolean | null;
} {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(evidenceDir, `${taskId}-${stamp}.json`);
  const env = {
    ...process.env,
    BABEL_HEADLESS: '1',
    BABEL_DIFF_CRITIC: '1',
    CI: process.env['CI'] ?? '1',
  };

  process.stdout.write(`\n=== Live remeasure ${taskId} (critic ON) ===\n`);

  // Clean stale workspace from prior runs to avoid EPERM/index.lock issues
  const workspaceDir = join(evidenceDir, 'workspaces', taskId);
  if (existsSync(workspaceDir)) {
    try {
      // On Windows, try removing .git/index.lock specifically first
      const lockPath = join(workspaceDir, '.git', 'index.lock');
      if (existsSync(lockPath)) {
        try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
      }
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`[warn] could not clean workspace for ${taskId}: ${err}\n`);
    }
  }

  // NOTE:
  // - Do NOT pass --live (sets runnableOnly and drops SWE cells).
  // - Pass --full so executeExternal=true (required for requires_dataset SWE cells).
  // - --task still scopes to a single cell when provided.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/run_agent_benchmark.ts',
      '--full',
      '--task',
      taskId,
      '--json',
      '--output',
      outPath,
      '--evidence-dir',
      evidenceDir,
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45 * 60 * 1000,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  let criticVerdict: string | null = null;
  let status: string | null = null;
  let correct: boolean | null = null;
  let criticInstrumentation: string | null = null;

  if (existsSync(outPath)) {
    try {
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
        results?: Array<{
          status?: string;
          verifier?: string;
          false_complete?: boolean;
          payload?: { critic_receipt?: { verdict?: string } };
          notes?: string | string[];
        }>;
      };
      const row = report.results?.[0];
      status = row?.status ?? null;
      // Prefer nested critic_receipt when present in cell payload notes/artifacts
      criticVerdict = row?.payload?.critic_receipt?.verdict ?? null;
      const notesText = Array.isArray(row?.notes)
        ? row.notes.join(' ')
        : typeof row?.notes === 'string'
          ? row.notes
          : '';
      if (!criticVerdict && notesText) {
        const m = /critic[_\s]?verdict[=:](\w+)/i.exec(notesText);
        if (m) criticVerdict = m[1] ?? null;
        if (/critic_instrumentation=missing_after_writes/i.test(notesText)) {
          criticInstrumentation = 'missing_after_writes';
        }
      }
      correct = row?.verifier === 'pass' || row?.status === 'success';
    } catch {
      /* ignore parse */
    }
  }

  // P1.3: harness sidecar — top-level critic_receipt + cli_payload + instrumentation
  const harnessCandidates = [
    join(evidenceDir, `${taskId}-harness.json`),
    join(evidenceDir, taskId, 'harness.json'),
  ];
  for (const h of harnessCandidates) {
    if (!existsSync(h)) continue;
    try {
      const harness = JSON.parse(readFileSync(h, 'utf8')) as {
        verifier_ok?: boolean;
        critic_receipt?: { verdict?: string } | null;
        critic_instrumentation?: string;
        cli_payload?: { critic_receipt?: { verdict?: string }; status?: string } | null;
      };
      if (harness.verifier_ok === true) correct = true;
      // Top-level sidecar wins over nested payload when present (C2).
      if (harness.critic_receipt?.verdict) {
        criticVerdict = harness.critic_receipt.verdict;
      } else if (harness.cli_payload?.critic_receipt?.verdict) {
        criticVerdict = harness.cli_payload.critic_receipt.verdict;
      }
      if (typeof harness.critic_instrumentation === 'string') {
        criticInstrumentation = harness.critic_instrumentation;
      }
      if (harness.cli_payload?.status) status = harness.cli_payload.status;
    } catch {
      /* ignore */
    }
  }

  return {
    task: taskId,
    exitCode: result.status ?? 1,
    reportPath: existsSync(outPath) ? outPath : null,
    criticVerdict,
    criticInstrumentation,
    status,
    correct,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.a09Acceptance || (!args.task && !args.allSwe)) {
    if (!args.a09Acceptance) {
      process.stdout.write('No live flags — defaulting to offline A09 acceptance.\n');
    }
    const code = runA09Acceptance();
    process.exit(code);
  }

  // P0.1–P0.2: rebuild stale dist before any live cell spawns dist/index.js
  await ensureDistBeforeLive();

  const evidenceDir = ensureEvidenceDir();
  const tasks = args.allSwe
    ? Array.from({ length: 10 }, (_, i) => `SWE-A${String(i + 1).padStart(2, '0')}`)
    : [args.task];

  if (tasks.some((t) => !t)) {
    printHelp();
    process.exit(2);
  }

  const rows = [];
  for (const task of tasks) {
    rows.push(runLiveTask(task, evidenceDir));
    // Clean workspace after each task to prevent disk accumulation
    const wsDir = join(evidenceDir, 'workspaces', task);
    if (existsSync(wsDir)) {
      try { rmSync(wsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  const rollup = {
    schema_version: 1,
    benchmark_type: 'babel_swe_a_critic_remeasure',
    generated_at: new Date().toISOString(),
    critic: {
      enabled: true,
      model: process.env['BABEL_DIFF_CRITIC_MODEL'] ?? 'deepseek-v4-flash',
    },
    baseline_reference: 'benchmarks/baselines/baseline-T1.4-swe-a-breadth-2026-07-08.json',
    exit_criterion:
      'Track correct_rate vs T1.4 (2/10). A09-class: wrong localization should draw critic reject before ANSWER_READY when possible.',
    summary: {
      n: rows.length,
      success: rows.filter((r) => r.correct === true).length,
      failure: rows.filter((r) => r.correct === false).length,
      critic_reject_seen: rows.filter((r) => r.criticVerdict === 'reject').length,
      critic_pass_seen: rows.filter((r) => r.criticVerdict === 'pass').length,
      critic_skip_seen: rows.filter((r) => r.criticVerdict === 'skip').length,
      // P1.3: missing receipt after writes is instrumentation fail, not "0 rejects"
      critic_instrumentation_missing: rows.filter(
        (r) => r.criticInstrumentation === 'missing_after_writes' || (!r.criticVerdict && r.correct !== true),
      ).length,
    },
    cells: rows,
  };

  const rollupPath = join(
    evidenceDir,
    `rollup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(rollupPath, JSON.stringify(rollup, null, 2), 'utf8');
  process.stdout.write(`\nRollup written: ${rollupPath}\n`);
  process.stdout.write(JSON.stringify(rollup.summary, null, 2) + '\n');

  // Non-zero if any hard spawn failure
  const hardFail = rows.some((r) => r.exitCode !== 0 && r.reportPath === null);
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
