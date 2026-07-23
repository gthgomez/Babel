import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Command } from 'commander';

import { analyzeProjectRoot, writeOnboardingReport } from '../services/projectOnboarding.js';
import { buildRepoMap, formatRepoMapHuman } from '../services/indexer.js';
import { formatGitDraftHuman, runGitDraft } from '../services/gitDrafts.js';
import {
  listProjectTemplates,
  normalizeProjectTemplate,
  scaffoldProject,
} from '../services/projectScaffold.js';
import {
  formatWorkspaceFileListHuman,
  formatWorkspacePolicyHuman,
  formatWorkspaceVerifyHuman,
  getWorkspacePolicyStatus,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveApprovedWorkspacePath,
  verifyWorkspaceProject,
} from '../services/workspaceManager.js';

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printError(message: string, json: boolean): never {
  if (json) {
    printJson({ status: 'failed', error: message });
  } else {
    console.error(`[babel] ${message}`);
  }
  process.exit(1);
}

function formatOnboardingHuman(
  reportPath: string,
  report: ReturnType<typeof analyzeProjectRoot>,
): string {
  return [
    `Onboarded: ${report.project_root}`,
    `Report: ${reportPath}`,
    `Recommended execution profile: ${report.recommended_execution_profile}`,
    `Detected stacks: ${report.detected_stacks.length > 0 ? report.detected_stacks.join(', ') : '(none)'}`,
    `Build commands: ${report.recommended_commands.build.length > 0 ? report.recommended_commands.build.join(', ') : '(none)'}`,
    `Test commands: ${report.recommended_commands.test.length > 0 ? report.recommended_commands.test.join(', ') : '(none)'}`,
  ].join('\n');
}

export function registerProjectCommands(program: Command): void {
  const filesCommand = program
    .command('files')
    .description('Workspace-safe file inspection through approved Babel roots')
    .action(() => {
      filesCommand.help({ error: false });
    });

  filesCommand
    .command('roots')
    .description('Show approved workspace roots and manager policy')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      try {
        const status = getWorkspacePolicyStatus();
        if (options.json === true) {
          printJson(status);
        } else {
          process.stdout.write(`${formatWorkspacePolicyHuman(status)}\n`);
        }
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error), options.json === true);
      }
    });

  filesCommand
    .command('list')
    .description('List files under an approved workspace root')
    .argument('<path>', 'Directory to list')
    .option('--recursive', 'List recursively, skipping common dependency/build directories')
    .option('--max <count>', 'Maximum entries to return', '200')
    .option('--json', 'Emit structured JSON only')
    .action((pathArg: string, options: { recursive?: boolean; max?: string; json?: boolean }) => {
      try {
        const maxEntries = Number.parseInt(options.max ?? '200', 10);
        if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
          throw new Error('--max must be a positive integer.');
        }
        const result = listWorkspaceFiles(pathArg, {
          recursive: options.recursive === true,
          maxEntries,
        });
        if (options.json === true) {
          printJson(result);
        } else {
          process.stdout.write(`${formatWorkspaceFileListHuman(result)}\n`);
        }
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error), options.json === true);
      }
    });

  filesCommand
    .command('read')
    .description('Read a text file under an approved workspace root')
    .argument('<path>', 'File to read')
    .option('--max-bytes <bytes>', 'Maximum bytes to read', '200000')
    .option('--json', 'Emit structured JSON only')
    .action((pathArg: string, options: { maxBytes?: string; json?: boolean }) => {
      try {
        const maxBytes = Number.parseInt(options.maxBytes ?? '200000', 10);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
          throw new Error('--max-bytes must be a positive integer.');
        }
        const result = readWorkspaceFile(pathArg, { maxBytes });
        if (options.json === true) {
          printJson(result);
        } else {
          process.stdout.write(result.content);
          if (!result.content.endsWith('\n')) {
            process.stdout.write('\n');
          }
        }
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error), options.json === true);
      }
    });

  program
    .command('verify')
    .description('Run approved local verification commands inside an approved workspace root')
    .argument('[path]', 'Project root to verify', '.')
    .option(
      '--commands <commands>',
      'Semicolon-separated commands to run instead of detected test/build/lint commands',
    )
    .option('--timeout <seconds>', 'Per-command timeout in seconds', '300')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel verify /tmp/SomeRepo --json
  $ babel verify /tmp/example_game_suite\\MyGame --commands "npm test;npm run build" --json

Notes:
  - Uses execution profile opencalw_manager.
  - Repos under /tmp are approved by default; set BABEL_OPENCLAW_APPROVED_ROOTS for a tighter allowlist.
  - Dependency installs are blocked unless explicitly approved outside this command.
`,
    )
    .action((pathArg: string, options: { commands?: string; timeout?: string; json?: boolean }) => {
      try {
        const timeoutSeconds = Number.parseInt(options.timeout ?? '300', 10);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          throw new Error('--timeout must be a positive integer.');
        }
        const commands = String(options.commands ?? '')
          .split(';')
          .map((command) => command.trim())
          .filter((command) => command.length > 0);
        const result = verifyWorkspaceProject(pathArg, {
          ...(commands.length > 0 ? { commands } : {}),
          timeoutSeconds,
        });
        if (options.json === true) {
          printJson(result);
        } else {
          process.stdout.write(`${formatWorkspaceVerifyHuman(result)}\n`);
        }
        if (result.status === 'fail') {
          process.exit(1);
        }
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error), options.json === true);
      }
    });

  program
    .command('diff')
    .description('Draft a JSON-first diff summary for an approved workspace root')
    .argument('[path]', 'Project root to inspect', '.')
    .option('--base-ref <ref>', 'Optional base ref')
    .option('--json', 'Emit structured JSON only')
    .action((pathArg: string, options: { baseRef?: string; json?: boolean }) => {
      try {
        const resolved = resolveApprovedWorkspacePath(pathArg);
        const result = runGitDraft('diff_summary', {
          projectRoot: resolved.path,
          ...(options.baseRef ? { baseRef: options.baseRef } : {}),
        });
        if (options.json === true) {
          printJson(result);
        } else {
          process.stdout.write(`${formatGitDraftHuman(result)}\n`);
        }
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error), options.json === true);
      }
    });

  program
    .command('repo-map')
    .description('Build a compact symbol-oriented map of a project for agent context')
    .argument('[path]', 'Project root to map', '.')
    .option('--target <path>', 'Only include files under this project-relative path')
    .option('--limit <count>', 'Maximum files to include', '200')
    .option('--preview', 'Include short content previews')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel repo-map .
  $ babel repo-map /tmp/SomeRepo --json
  $ babel repo-map . --target src --limit 80 --preview
`,
    )
    .action(
      async (
        pathArg: string,
        options: { target?: string; limit?: string; preview?: boolean; json?: boolean },
      ) => {
        try {
          const limit = Number.parseInt(options.limit ?? '200', 10);
          if (!Number.isFinite(limit) || limit <= 0) {
            throw new Error('--limit must be a positive integer.');
          }
          const repoMap = await buildRepoMap(resolve(pathArg), {
            limit,
            target: options.target,
            includePreview: options.preview === true,
          });
          if (options.json === true) {
            printJson({ status: 'ok', repo_map: repoMap });
          } else {
            process.stdout.write(`${formatRepoMapHuman(repoMap)}\n`);
          }
        } catch (error: unknown) {
          printError(error instanceof Error ? error.message : String(error), options.json === true);
        }
      },
    );

  program
    .command('onboard-project')
    .description('Inspect an arbitrary project and write a Babel onboarding report')
    .argument('[path]', 'Project root to inspect', '.')
    .option(
      '--write-project-context',
      'Write the generated PROJECT_CONTEXT.md draft into the target project',
    )
    .option('--force', 'Allow --write-project-context to overwrite an existing PROJECT_CONTEXT.md')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel onboard-project .
  $ babel onboard-project /tmp/SomeRepo --json
  $ babel onboard-project . --write-project-context --force

Notes:
  - The default command is read-only for the target project and writes only a run report under Babel runs/onboarding.
  - --write-project-context is explicit because PROJECT_CONTEXT.md is durable project context.
`,
    )
    .action(
      (
        pathArg: string,
        options: { writeProjectContext?: boolean; force?: boolean; json?: boolean },
      ) => {
        try {
          const projectRoot = resolve(pathArg);
          const report = analyzeProjectRoot(projectRoot);
          const reportPath = writeOnboardingReport(report);
          const payload: Record<string, unknown> = {
            status: 'ok',
            report_path: reportPath,
            report,
          };

          if (options.writeProjectContext === true) {
            const contextPath = join(projectRoot, 'PROJECT_CONTEXT.md');
            if (existsSync(contextPath) && options.force !== true) {
              throw new Error(
                `PROJECT_CONTEXT.md already exists at ${contextPath}. Use --force to overwrite it.`,
              );
            }
            writeFileSync(contextPath, `${report.context_draft}\n`, 'utf-8');
            payload['project_context_path'] = contextPath;
          }

          if (options.json === true) {
            printJson(payload);
          } else {
            process.stdout.write(`${formatOnboardingHuman(reportPath, report)}\n`);
          }
        } catch (error: unknown) {
          printError(error instanceof Error ? error.message : String(error), options.json === true);
        }
      },
    );

  program
    .command('create')
    .description('Scaffold a new project from a deterministic Babel template')
    .argument('<template>', `Template: ${listProjectTemplates().join(' | ')}`)
    .argument('<path>', 'Target directory')
    .option('--force', 'Allow overwriting scaffold files in an existing target directory')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel create node-cli .\\scratch\\hello-cli
  $ babel create python-cli .\\scratch\\hello-py --json
  $ babel create vite-react .\\scratch\\hello-web
`,
    )
    .action(
      (templateArg: string, pathArg: string, options: { force?: boolean; json?: boolean }) => {
        try {
          const template = normalizeProjectTemplate(templateArg);
          if (template === null) {
            throw new Error(
              `Invalid template "${templateArg}". Valid values: ${listProjectTemplates().join(', ')}`,
            );
          }
          const result = scaffoldProject({
            template,
            targetRoot: pathArg,
            ...(options.force === true ? { force: true } : {}),
          });
          if (options.json === true) {
            printJson(result);
          } else {
            process.stdout.write(
              [
                `Created ${result.template} project: ${result.target_root}`,
                `Files written: ${result.files_written.length}`,
                'Next commands:',
                ...result.next_commands.map((command) => `  ${command}`),
              ].join('\n') + '\n',
            );
          }
        } catch (error: unknown) {
          printError(error instanceof Error ? error.message : String(error), options.json === true);
        }
      },
    );
}
