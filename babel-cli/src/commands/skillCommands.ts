import { Command } from 'commander';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  auditSkillPath,
  createSkill,
  exportSkillToCodex,
  formatSkillAuditHuman,
  formatSkillCreateHuman,
  formatSkillExportHuman,
  formatSkillListHuman,
  formatValidationHuman,
  listSkills,
  validateSkillPath,
} from '../services/skillForge.js';
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js';

export function registerSkillCommands(program: Command): void {
  const skillCommand = program
    .command('skill')
    .description('Create, validate, audit, and list governed Babel skills')
    .action(() => {
      const report = listSkills(BABEL_ROOT);
      printJsonOrHuman(report, formatSkillListHuman(report), false);
    });

  skillCommand
    .command('new')
    .description('Scaffold a governed Babel skill')
    .argument('<name>', 'Skill name')
    .option('--json', 'Emit structured JSON only')
    .action((name: string, options: { json?: boolean }) => {
      try {
        const report = createSkill(name, BABEL_ROOT);
        printJsonOrHuman(report, formatSkillCreateHuman(report), options.json === true);
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

  skillCommand
    .command('validate')
    .description('Validate a governed Babel skill folder')
    .argument('<path>', 'Skill folder path')
    .option('--json', 'Emit structured JSON only')
    .action((pathArg: string, options: { json?: boolean }) => {
      const report = validateSkillPath(pathArg);
      printJsonOrHuman(report, formatValidationHuman(report), options.json === true);
      if (report.status === 'fail') {
        process.exit(1);
      }
    });

  skillCommand
    .command('audit')
    .description('Audit a governed Babel skill folder')
    .argument('<path>', 'Skill folder path')
    .option('--json', 'Emit structured JSON only')
    .action((pathArg: string, options: { json?: boolean }) => {
      const report = auditSkillPath(pathArg);
      printJsonOrHuman(report, formatSkillAuditHuman(report), options.json === true);
      if (report.status === 'fail') {
        process.exit(1);
      }
    });

  skillCommand
    .command('list')
    .description('List governed Babel skills')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const report = listSkills(BABEL_ROOT);
      printJsonOrHuman(report, formatSkillListHuman(report), options.json === true);
    });

  const codexCommand = program
    .command('codex')
    .description('Codex interoperability commands')
    .action(() => {
      codexCommand.help({ error: false });
    });

  codexCommand
    .command('export-skill')
    .description('Export a reviewed or trusted Babel skill to the local Codex skills directory')
    .argument('<name>', 'Skill id, folder name, or display name')
    .option('--allow-experimental', 'Allow exporting experimental skills')
    .option('--destination <path>', 'Override the Codex skills destination root')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        name: string,
        options: { allowExperimental?: boolean; destination?: string; json?: boolean },
      ) => {
        try {
          const report = exportSkillToCodex(name, BABEL_ROOT, {
            allowExperimental: options.allowExperimental === true,
            ...(options.destination ? { destinationRoot: options.destination } : {}),
          });
          printJsonOrHuman(report, formatSkillExportHuman(report), options.json === true);
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
}
