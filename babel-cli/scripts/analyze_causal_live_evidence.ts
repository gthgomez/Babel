/**
 * Slice 7 CLI: offline analysis of live/gate0 causal evidence dirs.
 * No network, no API spend.
 *
 * Usage:
 *   npx tsx scripts/analyze_causal_live_evidence.ts --evidence-dir <path>
 *   npx tsx scripts/analyze_causal_live_evidence.ts --evidence-dir ../runs/agent-benchmark/swe-pro/gate0-canary-20260802-220222
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeLiveEvidenceDir,
  formatImprovementLedgerMarkdown,
  writeImprovementLedger,
} from '../src/services/causalLiveEvidence.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..');

function resolveOperatorPath(value: string): string {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRepo = resolve(repositoryRoot, value);
  if (existsSync(fromRepo)) return fromRepo;
  const fromPackage = resolve(packageRoot, value);
  if (existsSync(fromPackage)) return fromPackage;
  return fromCwd;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/analyze_causal_live_evidence.ts --evidence-dir <path> [options]',
      '',
      'Offline improvement-ledger analysis for SWE-Pro / causal canary evidence.',
      'No live spend. Works on historical gate0-canary dirs.',
      '',
      'Options:',
      '  --evidence-dir <path>  Evidence root (required)',
      '  --json                 Print ledger JSON to stdout (still writes files)',
      '  --no-write             Analyze only; do not write improvement-ledger.*',
      '  --help                 This help',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): {
  help: boolean;
  json: boolean;
  noWrite: boolean;
  evidenceDir: string;
} {
  const opts = { help: false, json: false, noWrite: false, evidenceDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-write') opts.noWrite = true;
    else if (a === '--evidence-dir') opts.evidenceDir = String(argv[++i] ?? '');
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

  const ledger = analyzeLiveEvidenceDir(evidenceDir);

  if (!opts.noWrite) {
    const written = writeImprovementLedger(evidenceDir, ledger);
    if (!opts.json) {
      process.stdout.write(written.markdown);
      process.stdout.write(`\n---\nwrote ${written.jsonPath}\nwrote ${written.markdownPath}\n`);
    }
  } else if (!opts.json) {
    process.stdout.write(formatImprovementLedgerMarkdown(ledger));
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
