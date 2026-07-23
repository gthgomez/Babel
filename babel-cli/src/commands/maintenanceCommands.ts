import { resolve } from 'node:path';

import { Command } from 'commander';

import { BABEL_ROOT } from '../cli/constants.js';
import { formatDocsAuditHuman, runDocsAudit } from '../services/docsFitness.js';
import {
  formatMaintenanceAuditHuman,
  runMaintenanceAudit,
  writeMaintenanceAuditReport,
} from '../services/maintenanceAudit.js';
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js';

export function registerMaintenanceCommands(program: Command): void {
  program
    .command('simplify')
    .description('Read-only repo cleanup audit for future-safe maintenance work')
    .argument('[target]', 'Optional file or directory to audit; defaults to changed CLI/docs files')
    .option('--all', 'Scan the Babel CLI and docs graph instead of only changed files')
    .option('--json', 'Emit structured JSON only')
    .option(
      '--write-report [path]',
      'Write maintenance_audit.json and maintenance_audit.md under runs/maintenance or at the given JSON path',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ babel simplify
  $ babel simplify --all
  $ babel simplify babel-cli/src/pipeline.ts
  $ babel simplify --all --json
  $ babel simplify --all --write-report
`,
    )
    .action(
      (
        target: string | undefined,
        options: { all?: boolean; json?: boolean; writeReport?: string | boolean },
      ) => {
        try {
          const initialReport = runMaintenanceAudit({
            repoRoot: BABEL_ROOT,
            ...(target ? { target } : {}),
            all: options.all === true,
          });
          const report =
            options.writeReport !== undefined
              ? writeMaintenanceAuditReport(initialReport, {
                  repoRoot: BABEL_ROOT,
                  outputPath: options.writeReport,
                })
              : initialReport;
          printJsonOrHuman(report, formatMaintenanceAuditHuman(report), options.json === true);
          if (report.status === 'fail') {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  const docsCommand = program
    .command('docs')
    .description('Audit and maintain Babel documentation authority')
    .action(() => {
      const report = runDocsAudit({ root: BABEL_ROOT });
      printJsonOrHuman(report, formatDocsAuditHuman(report), false);
      if (report.status === 'fail') {
        process.exit(1);
      }
    });

  docsCommand
    .command('audit')
    .description('Run the deterministic docs fitness audit')
    .option('--json', 'Emit structured JSON only')
    .option('--root <path>', 'Repo root to audit', BABEL_ROOT)
    .action((options: { json?: boolean; root?: string }) => {
      try {
        const report = runDocsAudit({ root: resolve(options.root ?? BABEL_ROOT) });
        printJsonOrHuman(report, formatDocsAuditHuman(report), options.json === true);
        if (report.status === 'fail') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });
}
