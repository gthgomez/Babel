import { loadBabelCliEnv } from './config/envBootstrap.js';
import { conversationScopeRequested } from './config/conversationScope.js';
import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js';
import { Command } from 'commander';
import { rewriteArgv } from './cli/argv.js';
import { isDeprecatedSurfaceCommand, printDeprecatedSurfaceAndExit } from './cli/deprecation.js';
import {
  applyProgramMetadata,
  applyUserFocusedHelpTiers,
  registerCoreCommands,
} from './commands/coreCommands.js';
import { registerProjectCommands } from './commands/projectCommands.js';
import { registerRemoteCommands } from './commands/remoteCommands.js';
import { registerWorkflowCommands } from './commands/workflowCommands.js';

export function runCli(argv: string[] = process.argv) {
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

  const program = new Command();
  applyProgramMetadata(program);
  registerCoreCommands(program);
  registerProjectCommands(program);
  registerWorkflowCommands(program);
  registerRemoteCommands(program);
  applyUserFocusedHelpTiers(program);

  const rewrittenArgv = rewriteArgv(argv);
  const surfaceCommand = rewrittenArgv[2];
  if (typeof surfaceCommand === 'string' && isDeprecatedSurfaceCommand(surfaceCommand)) {
    printDeprecatedSurfaceAndExit(surfaceCommand);
  }
  program.parse(rewrittenArgv);
}

export async function startCli(argv: string[] = process.argv) {
  if (!isDesktopCapabilityProbe(argv)) {
    loadBabelCliEnv(process.env, undefined, {
      executionScope: conversationScopeRequested(argv) ? 'conversation' : 'project',
    });
    process.env['BABEL_ENV_LOADED'] = 'true';
  }
  runCli(argv);
}
