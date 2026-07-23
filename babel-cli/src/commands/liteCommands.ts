import { Command } from 'commander';

import { LiteError } from '../lite/config.js';
import {
  formatLiteAskText,
  formatLitePatchText,
  formatLitePlanText,
  formatLiteProvidersText,
  runLiteAsk,
  runLitePatch,
  runLitePlan,
  runLiteProviders,
  type LitePrivacyMode,
} from '../lite/commands.js';
import { redactSecrets } from '../utils/redaction.js';

const LITE_COMMAND_HELP = `
Examples:
  $ babel advanced text-provider providers
  $ babel advanced text-provider plan --repo . --task "Add a focused test"
  $ babel advanced text-provider ask --provider mock --task "Explain the failure"
  $ babel advanced text-provider patch --provider mock --task "Propose a diff only"

Notes:
  - Internal text-provider lane only. Daily work uses babel "<task>", babel plan, and babel deep.
  - plan performs no API call.
  - ask and patch save artifacts under runs/babel-lite by default.
  - patch never applies changes automatically.
`;

const LITE_ROOT_HELP = `
Examples:
  $ babel advanced text-provider providers
  $ babel advanced text-provider plan --repo . --task "Add a focused test"
  $ babel advanced text-provider ask --provider mock --task "Explain the failure"
  $ babel advanced text-provider patch --provider mock --task "Propose a diff only"

Notes:
  - Internal text-provider lane only. Daily work uses babel "<task>", babel plan, and babel deep.
  - plan performs no API call.
  - ask and patch save artifacts under runs/babel-lite by default.
  - patch never applies changes automatically.
`;

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printJsonOrText(payload: unknown, text: string, json: boolean): void {
  if (json) {
    printJson(payload);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function printLiteError(error: unknown, json: boolean): never {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const payload = {
    schema_version: 1,
    status: 'failed',
    error:
      error instanceof LiteError
        ? {
            code: error.code,
            message,
            provider: error.providerId,
            env_key: error.envKeyName,
            env_keys: error.envKeyNames,
            status_code: error.statusCode,
          }
        : {
            code: 'PROVIDER_REQUEST_FAILED',
            message,
          },
  };

  if (json) {
    printJson(payload);
  } else {
    console.error(`[babel-lite] ${message}`);
  }
  process.exit(1);
}

function registerLiteSubcommands(command: Command): void {
  command
    .command('providers')
    .description('List Babel Lite providers and key presence without printing secrets')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      try {
        const result = runLiteProviders();
        printJsonOrText(result, formatLiteProvidersText(result), options.json === true);
      } catch (error: unknown) {
        printLiteError(error, options.json === true);
      }
    });

  command
    .command('plan')
    .description('Create a local no-API task contract')
    .requiredOption('--task <task>', 'Task prompt')
    .option('--repo <path>', 'Repository root to inspect', '.')
    .option('--json', 'Emit structured JSON only')
    .action((options: { task?: string; repo?: string; json?: boolean }) => {
      try {
        const result = runLitePlan({
          repoPath: options.repo ?? '.',
          task: options.task ?? '',
        });
        printJsonOrText(result, formatLitePlanText(result), options.json === true);
      } catch (error: unknown) {
        printLiteError(error, options.json === true);
      }
    });

  command
    .command('ask')
    .description('Ask a Lite API provider using a compact contract; no file edits')
    .requiredOption('--task <task>', 'Task prompt')
    .option('--repo <path>', 'Repository root to inspect', '.')
    .option('--provider <provider>', 'Provider: auto | deepseek | deepinfra | mock', 'auto')
    .option('--model <model>', 'Provider model override')
    .option('--privacy <mode>', 'Provider payload privacy: redacted | full', 'redacted')
    .option('--json', 'Emit structured JSON only')
    .option('--stream', 'Stream answer content in real time')
    .action(
      async (options: {
        task?: string;
        repo?: string;
        provider?: string;
        model?: string;
        privacy?: LitePrivacyMode;
        json?: boolean;
        stream?: boolean;
      }) => {
        try {
          const onChunk =
            options.stream && !options.json
              ? (chunk: string) => process.stdout.write(chunk)
              : undefined;

          const result = await runLiteAsk({
            repoPath: options.repo ?? '.',
            task: options.task ?? '',
            provider: options.provider ?? 'auto',
            ...(options.model ? { model: options.model } : {}),
            ...(options.privacy ? { privacy: options.privacy } : {}),
            ...(onChunk ? { onChunk } : {}),
          });

          if (options.stream && !options.json) {
            process.stdout.write('\n'); // ensure clean line at end
            const metadata = [
              `Babel Lite ask: ${result.provider.id} (${result.provider.model})`,
              `Artifacts: ${result.artifacts.run_dir}`,
              '',
            ].join('\n');
            process.stdout.write(metadata);
          } else {
            printJsonOrText(result, formatLiteAskText(result), options.json === true);
          }
        } catch (error: unknown) {
          printLiteError(error, options.json === true);
        }
      },
    );

  command
    .command('patch')
    .description('Ask a Lite API provider for a patch proposal; never auto-applies')
    .requiredOption('--task <task>', 'Task prompt')
    .option('--repo <path>', 'Repository root to inspect', '.')
    .option('--provider <provider>', 'Provider: auto | deepseek | deepinfra | mock', 'auto')
    .option('--model <model>', 'Provider model override')
    .option('--privacy <mode>', 'Provider payload privacy: redacted | full', 'redacted')
    .option('--json', 'Emit structured JSON only')
    .action(
      async (options: {
        task?: string;
        repo?: string;
        provider?: string;
        model?: string;
        privacy?: LitePrivacyMode;
        json?: boolean;
      }) => {
        try {
          const result = await runLitePatch({
            repoPath: options.repo ?? '.',
            task: options.task ?? '',
            provider: options.provider ?? 'auto',
            ...(options.model ? { model: options.model } : {}),
            ...(options.privacy ? { privacy: options.privacy } : {}),
          });
          printJsonOrText(result, formatLitePatchText(result), options.json === true);
        } catch (error: unknown) {
          printLiteError(error, options.json === true);
        }
      },
    );
}

export function registerLiteCommands(program: Command): void {
  const liteCommand = program
    .command('lite')
    .description('Compact governance-first task contract and provider fallback commands')
    .addHelpText('after', LITE_COMMAND_HELP);

  registerLiteSubcommands(liteCommand);
}

/** Internal provider-contract lane — not the daily CLI workflow surface. */
export function registerInternalTextProviderCommands(program: Command): void {
  const command = program
    .command('text-provider')
    .description('Internal text-provider lane (ask/plan/patch with --task/--repo flags)')
    .addHelpText(
      'after',
      `
Notes:
  - This is an internal provider-contract lane, not the product definition of Babel Lite.
  - Daily work should use babel "<task>", babel plan, babel deep, and babel undo.
`,
    );
  registerLiteSubcommands(command);
  (command as unknown as { _hidden: boolean })._hidden = true;
}

export function applyLiteProgramMetadata(program: Command): void {
  program
    .name('babel-lite')
    .description('Babel Lite — compact governance-first CLI companion')
    .version('1.0.0')
    .addHelpText('after', LITE_ROOT_HELP);
}

export function registerLiteRootCommands(program: Command): void {
  registerLiteSubcommands(program);
}
