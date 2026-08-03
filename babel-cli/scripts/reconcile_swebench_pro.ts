/**
 * External owner for SWE-Pro / causal campaign attempt reconciliation.
 *
 * The campaign worker cannot mark itself orphaned after process death.
 * Monitor and harvest invoke this idempotently.
 *
 * Usage:
 *   npx tsx scripts/reconcile_swebench_pro.ts --evidence-dir <path> [--grace-ms 15000] [--json]
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcileCampaignEvidence } from '../src/services/causalCampaignContract.js';
import { writeDerivedCampaignState } from '../src/services/causalCampaignValidator.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..');

function resolveOperatorPath(value: string): string {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(repositoryRoot, value);
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/reconcile_swebench_pro.ts --evidence-dir <path> [options]',
      '',
      'Idempotent external reconcile for causal Stage 1 attempt lifecycle.',
      'Requires campaign-manifest.json. Marks queued/running attempts orphaned only when:',
      '  - process tree is dead',
      '  - process creation identity is known (or grace from manifest age)',
      '  - grace period has elapsed',
      '',
      'Options:',
      '  --evidence-dir <path>  Evidence root (required)',
      '  --grace-ms <n>         Orphan grace after last activity (default 15000)',
      '  --json                 Print reconcile-report JSON only',
      '  --help                 This help',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): {
  help: boolean;
  json: boolean;
  evidenceDir: string;
  graceMs: number;
} {
  const opts = { help: false, json: false, evidenceDir: '', graceMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--evidence-dir') opts.evidenceDir = String(argv[++i] ?? '');
    else if (a === '--grace-ms') opts.graceMs = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.evidenceDir) {
    printHelp();
    process.exitCode = 2;
    return;
  }
  const evidenceDir = resolveOperatorPath(opts.evidenceDir);
  if (!existsSync(evidenceDir)) {
    process.stderr.write(`Evidence dir not found: ${evidenceDir}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = reconcileCampaignEvidence({
      evidenceDir,
      graceMs: opts.graceMs,
    });
    // Rebuild derived eligibility after orphan reconciliation (Slice 3).
    let derivedSummary = 'derived=skipped';
    try {
      const derived = writeDerivedCampaignState({ evidenceDir });
      derivedSummary = `derived_complete=${derived.eligibility.campaign_complete} reliability_eligible=${derived.eligibility.reliability_eligible} promotion_eligible=${derived.eligibility.promotion_eligible}`;
    } catch (e) {
      derivedSummary = `derived=error:${e instanceof Error ? e.message : String(e)}`;
    }
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ reconcile: report, derived_summary: derivedSummary }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        [
          `campaign_id=${report.campaign_id}`,
          `campaign_complete=${report.campaign_complete}`,
          `conservation_ok=${report.conservation_ok}`,
          `process_tree_alive=${report.process_tree_alive}`,
          `grace_remaining_ms=${report.grace_remaining_ms}`,
          `orphaned=${report.orphaned_attempt_ids.length}`,
          `by_lifecycle=${JSON.stringify(report.by_lifecycle)}`,
          derivedSummary,
          report.conservation_errors.length
            ? `errors=${report.conservation_errors.join(' | ')}`
            : 'errors=none',
        ].join('\n') + '\n',
      );
    }
    process.exitCode = report.conservation_ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}

void main();
