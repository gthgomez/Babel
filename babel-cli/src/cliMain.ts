import { loadBabelCliEnv } from './config/envBootstrap.js';
import { conversationScopeRequested } from './config/conversationScope.js';
import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js';
import { withInvocationSettings } from './config/invocationSettings.js';
import { Command } from 'commander';
import { rewriteArgv } from './cli/argv.js';
import { invokedCliName } from './cli/commandName.js';
import { isWorkHelpRequest, workHelpText } from './cli/workHelp.js';
import { isDeprecatedSurfaceCommand, printDeprecatedSurfaceAndExit } from './cli/deprecation.js';
import {
  applyProgramMetadata,
  applyUserFocusedHelpTiers,
  registerCoreCommands,
} from './commands/coreCommands.js';
import { registerProjectCommands } from './commands/projectCommands.js';
import { registerRemoteCommands } from './commands/remoteCommands.js';
import { registerWorkflowCommands } from './commands/workflowCommands.js';

/** One registration graph for execution and command recognition. */
export function createCliProgram(): Command {
  const program = new Command();
  applyProgramMetadata(program);
  registerCoreCommands(program);
  registerProjectCommands(program);
  registerWorkflowCommands(program);
  registerRemoteCommands(program);
  applyUserFocusedHelpTiers(program);

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n');
    return;
  }
  if (argv[1]) {
    const filename = argv[1].split(/[\\/]/).pop()?.toLowerCase();
    if (filename === 'bl.js' || filename === 'bl') {
      printDeprecatedSurfaceAndExit('bl');
    }
    if (filename === 'babel-lite.js' || filename === 'babel-lite') {
      printDeprecatedSurfaceAndExit('babel-lite');
    }
  }

  const program = createCliProgram();

  // `work` is rewritten to `run --mode chat`; answer its help before the
  // rewrite so users see the work entrypoint instead of advanced run options.
  if (isWorkHelpRequest(argv)) {
    process.stdout.write(`${workHelpText(invokedCliName(argv[1]))}\n`);
    return;
  }

  const registeredCommands = new Set(program.commands.flatMap(command => [command.name(), ...command.aliases()]));
  const rewrittenArgv = rewriteArgv(argv, registeredCommands);
  const surfaceCommand = rewrittenArgv[2];
  if (typeof surfaceCommand === 'string' && isDeprecatedSurfaceCommand(surfaceCommand)) {
    printDeprecatedSurfaceAndExit(surfaceCommand);
  }
  await withInvocationSettings({}, () => program.parseAsync(rewrittenArgv));
}

export async function startCli(argv: string[] = process.argv) {
  if (!isDesktopCapabilityProbe(argv)) {
    loadBabelCliEnv(process.env, undefined, {
      executionScope: conversationScopeRequested(argv) ? 'conversation' : 'project',
    });
    process.env['BABEL_ENV_LOADED'] = 'true';
  }
  await runCli(argv);
}
