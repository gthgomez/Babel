#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dispatchEntry = resolve(__dirname, '../dist/cliEntryDispatch.js');
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 19) || (major === 24 && (minor > 13 || (minor === 13 && patch >= 1))))) {
  console.error('[babel-agent] Node ^22.19.0 or ^24.13.1 is required.');
  process.exit(1);
}

if (!existsSync(dispatchEntry)) {
  console.error(
    `[babel] Missing build output at "${dispatchEntry}". Run "npm --prefix .\\babel-cli run build" from the repo root first.`,
  );
  process.exit(1);
}

const { routeInteractiveWarnings } = await import(pathToFileURL(resolve(__dirname, '../dist/cli/interactiveWarningRoute.js')).href);
if (!(await routeInteractiveWarnings())) {
  const { dispatchExecutableCli } = await import(pathToFileURL(dispatchEntry).href);
  await dispatchExecutableCli();
}
