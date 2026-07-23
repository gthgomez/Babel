#!/usr/bin/env node

import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __envDir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__envDir, '../.env'), override: true, debug: false, quiet: true });
process.env['BABEL_ENV_LOADED'] = 'true';

import { Command } from 'commander';

import { rewriteArgv } from './cli/argv.js';
import { isDeprecatedSurfaceCommand, printDeprecatedSurfaceAndExit } from './cli/deprecation.js';
import {
  applyProgramMetadata,
  applyUserFocusedHelpTiers,
  registerCoreCommands,
} from './commands/coreCommands.js';
import { registerProjectCommands } from './commands/projectCommands.js';
import { registerWorkflowCommands } from './commands/workflowCommands.js';

export function runCli(argv: string[] = process.argv) {
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
  applyUserFocusedHelpTiers(program);

  const rewrittenArgv = rewriteArgv(argv);
  const surfaceCommand = rewrittenArgv[2];
  if (typeof surfaceCommand === 'string' && isDeprecatedSurfaceCommand(surfaceCommand)) {
    printDeprecatedSurfaceAndExit(surfaceCommand);
  }
  program.parse(rewrittenArgv);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('babel.js') ||
    process.argv[1].endsWith('babel-lite.js') ||
    process.argv[1].endsWith('bl.js') ||
    process.argv[1].endsWith('index.js') ||
    process.argv[1].endsWith('index.ts'));

if (isMain) {
  runCli();
}
