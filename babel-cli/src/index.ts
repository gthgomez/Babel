#!/usr/bin/env node

import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __envDir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__envDir, '../.env'), override: false, debug: false, quiet: true });

import { Command } from 'commander';

import { rewriteArgv } from './cli/argv.js';
import { applyProgramMetadata, applyUserFocusedHelpTiers, registerCoreCommands } from './commands/coreCommands.js';
import { registerProjectCommands } from './commands/projectCommands.js';
import { registerWorkflowCommands } from './commands/workflowCommands.js';

const program = new Command();
applyProgramMetadata(program);
registerCoreCommands(program);
registerProjectCommands(program);
registerWorkflowCommands(program);
applyUserFocusedHelpTiers(program);

program.parse(rewriteArgv(process.argv));
