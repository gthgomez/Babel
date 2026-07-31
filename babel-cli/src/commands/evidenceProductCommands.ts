/**
 * W3.2–W3.3 — CLI registration for implementor evidence open/export + scorecard.
 * Kept out of coreCommands.ts for architectural file-size budget.
 */

import { readFileSync } from 'node:fs';

import { type Command } from 'commander';

import {
  formatImplementorScorecardHuman,
  runImplementorScorecard,
} from '../agent/implementorScorecard.js';
import {
  buildShadowPrecisionRecallReport,
  formatShadowPrecisionRecallHuman,
  parsePolicyEventsFromText,
} from '../agent/policyShadowPrecisionRecall.js';
import {
  exportEvidenceBundle,
  formatEvidenceExportHuman,
  formatEvidenceOpenHuman,
  openEvidence,
} from '../services/evidenceProduct.js';
import { printJsonOrHuman } from './output.js';

/**
 * Attach `evidence open`, `evidence export`, and `evidence scorecard`.
 */
export function registerEvidenceProductSubcommands(evidenceCommand: Command): void {
  evidenceCommand
    .command('open')
    .description('Open/summarize implementor evidence for a run (fast failure diagnose)')
    .option('--run <path>', 'Run directory (default: latest pointer)')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .action((options: { run?: string; project?: string; json?: boolean }) => {
      const report = openEvidence({
        ...(options.run ? { run: options.run } : {}),
        ...(options.project ? { project: options.project } : {}),
      });
      printJsonOrHuman(report, formatEvidenceOpenHuman(report), options.json === true);
      if (report.status === 'missing') process.exitCode = 1;
    });

  evidenceCommand
    .command('export')
    .description('Export a portable evidence bundle (directory + zip when available)')
    .option('--run <path>', 'Run directory (default: latest pointer)')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--output-dir <path>', 'Export destination directory')
    .option('--json', 'Emit structured JSON only')
    .action((options: { run?: string; project?: string; outputDir?: string; json?: boolean }) => {
      const opened = openEvidence({
        ...(options.run ? { run: options.run } : {}),
        ...(options.project ? { project: options.project } : {}),
      });
      if (!opened.run_dir) {
        printJsonOrHuman(
          opened,
          `No run to export: ${opened.summary.join(' ')}`,
          options.json === true,
        );
        process.exitCode = 1;
        return;
      }
      const report = exportEvidenceBundle({
        runDir: opened.run_dir,
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      });
      printJsonOrHuman(report, formatEvidenceExportHuman(report), options.json === true);
      if (report.status !== 'ok') process.exitCode = 1;
    });

  // W3.3 / S-EVL-01 — offline Grok-shadow implementor scorecard
  evidenceCommand
    .command('scorecard')
    .description(
      'Run offline implementor Grok-shadow scorecard (prove suite + false-positive dashboard)',
    )
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const report = runImplementorScorecard();
      printJsonOrHuman(report, formatImplementorScorecardHuman(report), options.json === true);
      if (!report.pass) process.exitCode = 1;
    });

  // P0-E — offline shadow would-kill precision/recall campaign report
  evidenceCommand
    .command('shadow-precision')
    .description(
      'Offline precision/recall for policy shadow would-kill events (later_succeeded / later_progressed)',
    )
    .option(
      '--events <path>',
      'JSON array or JSONL of policy events (*_shadow + policy_shadow_summary). Omit for fixtures.',
    )
    .option('--json', 'Emit structured JSON only')
    .action((options: { events?: string; json?: boolean }) => {
      let report;
      if (options.events) {
        const text = readFileSync(options.events, 'utf8');
        const events = parsePolicyEventsFromText(text);
        report = buildShadowPrecisionRecallReport({ events });
      } else {
        report = buildShadowPrecisionRecallReport({ useFixtures: true });
      }
      printJsonOrHuman(
        report,
        formatShadowPrecisionRecallHuman(report),
        options.json === true,
      );
    });
}
