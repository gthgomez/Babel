#!/usr/bin/env node

import './config/envBootstrap.js';

import { Command } from 'commander';

import {
  applyLiteProgramMetadata,
  registerLiteRootCommands,
} from './commands/liteCommands.js';

const program = new Command();
applyLiteProgramMetadata(program);
registerLiteRootCommands(program);

program.parse(process.argv);

