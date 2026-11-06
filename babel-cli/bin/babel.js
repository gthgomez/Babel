#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatNodeEngineError, nodeEngineSupported, suppressExperimentalWarnings } from './check-node-engine.mjs';

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

// Filter before the runtime imports node:sqlite and WebAssembly. A second
// process would change the pid used for interactive diagnostics.
suppressExperimentalWarnings();

const { routeInteractiveWarnings } = await import(pathToFileURL(resolve(__dirname, '../dist/cli/interactiveWarningRoute.js')).href);
if (!(await routeInteractiveWarnings())) {
  const { dispatchExecutableCli } = await import(pathToFileURL(dispatchEntry).href);
  await dispatchExecutableCli();
}
