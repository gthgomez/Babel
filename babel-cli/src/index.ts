#!/usr/bin/env node

import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js';

type CliMain = typeof import('./cliMain.js');

let cliMainPromise: Promise<CliMain> | null = null;

function loadCliMain(): Promise<CliMain> {
  if (!cliMainPromise) cliMainPromise = import('./cliMain.js');
  return cliMainPromise;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  return (await loadCliMain()).runCli(argv);
}

export async function startCli(argv: string[] = process.argv): Promise<void> {
  return (await loadCliMain()).startCli(argv);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));

if (isMain) {
  if (isDesktopCapabilityProbe(process.argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n');
  } else {
    await startCli();
  }
}
