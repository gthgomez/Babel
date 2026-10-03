#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distEntry = resolve(__dirname, '../dist/index.js');
const envBootstrapEntry = resolve(__dirname, '../dist/config/envBootstrap.js');
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 19) || (major === 24 && minor >= 5) || major > 24)) {
  console.error('[babel-agent] Node ^22.19.0 or >=24.5.0 is required.');
  process.exit(1);
}

if (!existsSync(distEntry)) {
  console.error(
    `[babel] Missing build output at "${distEntry}". Run "npm --prefix .\\babel-cli run build" from the repo root first.`,
  );
  process.exit(1);
}

if (existsSync(envBootstrapEntry)) {
  await import(pathToFileURL(envBootstrapEntry).href);
}

const { runCli } = await import(pathToFileURL(distEntry).href);
// Node retains a Unix npm symlink's executable name in argv[1].
if (!process.argv[1]?.endsWith('babel.js')) runCli();
