#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXPERIMENTAL_WARNING_FLAG,
  formatNodeEngineError,
  nodeEngineSupported,
  shouldRelaunchWithoutExperimentalWarnings,
} from './check-node-engine.mjs';

if (!nodeEngineSupported(process.versions.node)) {
  console.error(formatNodeEngineError(process.versions.node, 'command'));
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dispatchEntry = resolve(__dirname, '../dist/cliEntryDispatch.js');

if (!existsSync(dispatchEntry)) {
  console.error(
    `[babel-harness] Missing build output at "${dispatchEntry}". From the repo root, run "npm --prefix .\\babel-cli run build" first.`,
  );
  process.exit(1);
}

if (shouldRelaunchWithoutExperimentalWarnings({ execArgv: process.execArgv, env: process.env })) {
  const child = spawn(
    process.execPath,
    [...process.execArgv, EXPERIMENTAL_WARNING_FLAG, ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', () => {});
  process.on('SIGTERM', terminate);
  const code = await new Promise((resolveExit) => {
    child.once('error', () => resolveExit(1));
    child.once('exit', (status, signal) => {
      if (signal === 'SIGINT') resolveExit(130);
      else if (signal) resolveExit(1);
      else resolveExit(status ?? 1);
    });
  });
  process.exit(code);
}

const { routeInteractiveWarnings } = await import(pathToFileURL(resolve(__dirname, '../dist/cli/interactiveWarningRoute.js')).href);
if (!(await routeInteractiveWarnings())) {
  const { dispatchExecutableCli } = await import(pathToFileURL(dispatchEntry).href);
  await dispatchExecutableCli();
}
