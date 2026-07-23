/**
 * Guarded AGENTS.md local-to-draft-PR ship command.
 * Extracted from coreCommands.ts for architectural file-size budget (W3 options).
 */

import { type Command } from 'commander';

import { formatShipHuman, runShip } from '../services/ship.js';
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js';

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerShipCommand(program: Command): void {
  program
    .command('ship')
    .description('Run the guarded AGENTS.md local-to-draft-PR GitHub workflow')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--branch <branch>', 'Non-main branch to create or use')
    .option('--base-ref <ref>', 'Optional base ref for review evidence')
    .option('--message <message>', 'Commit message')
    .option('--title <title>', 'PR title (for remote PR creation)')
    .option('--body <body>', 'PR body (for remote PR creation)')
    .option('--check <command>', 'Verification command to run before mutation', collectOption, [])
    .option(
      '--verify <command>',
      'Alias for --check; repeat for multiple required checks',
      collectOption,
      [],
    )
    .option(
      '--dry-run',
      'Preview only without local or remote mutations (default unless --apply is passed)',
    )
    .option('--apply', 'Run local commit and optional remote push/PR')
    .option('--allow-main', 'Allow shipping from main/master')
    .option('--allow-mixed', 'Allow mixed or unrelated scopes')
    .option('--allow-remote', 'Allow push + draft PR')
    .option(
      '--no-pr',
      'Do not open a draft PR; keeps remote mutation disabled in the current workflow',
    )
    .option('--evidence-run <path>', 'Implementor run dir for evidence PR body (W3)')
    .option('--task <text>', 'Task summary for evidence PR body')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel ship --check "npm test" --apply
  $ babel ship --apply --allow-remote --check "npm test"
  $ babel ship --evidence-run runs/latest --check "npm test"

Hard stops include secrets (path + content scan), protected branches, generated artifacts, mixed/unrelated scopes, and failed verification.
Draft PR body is built from implementor evidence when --body is omitted (W3).
`,
    )
    .action(
      (options: {
        projectRoot?: string;
        branch?: string;
        baseRef?: string;
        message?: string;
        title?: string;
        body?: string;
        check?: string[];
        verify?: string[];
        dryRun?: boolean;
        apply?: boolean;
        allowMain?: boolean;
        allowMixed?: boolean;
        allowRemote?: boolean;
        pr?: boolean;
        evidenceRun?: string;
        task?: string;
        json?: boolean;
      }) => {
        try {
          const report = runShip({
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
            ...(options.branch ? { branch: options.branch } : {}),
            ...(options.message ? { message: options.message } : {}),
            ...(options.title ? { title: options.title } : {}),
            ...(options.body ? { body: options.body } : {}),
            ...(options.evidenceRun ? { evidenceRunDir: options.evidenceRun } : {}),
            ...(options.task ? { task: options.task } : {}),
            checkCommands: [...(options.check ?? []), ...(options.verify ?? [])],
            apply: options.apply === true && options.dryRun !== true,
            dryRun: options.dryRun === true,
            allowMain: options.allowMain === true,
            allowMixed: options.allowMixed === true,
            allowRemote: options.allowRemote === true && options.pr !== false,
          });
          printJsonOrHuman(report, formatShipHuman(report), options.json === true);
          if (report.status === 'blocked' || report.status === 'failed') {
            process.exitCode = 1;
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );
}
