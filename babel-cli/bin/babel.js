#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distEntry = resolve(__dirname, '../dist/index.js');

if (!existsSync(distEntry)) {
  console.error(
    `[babel] Missing build output at "${distEntry}". Run "npm run build" first.`,
  );
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);
