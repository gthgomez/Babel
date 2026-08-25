#!/usr/bin/env node
/**
 * Discover and run the complete UI test suite without shell-dependent globbing.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = join(packageRoot, 'src', 'ui');
// Keep this below the current 105-file inventory; update it deliberately when the suite shape changes.
const uiTestFileCountBaseline = 100;

async function discoverUiTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverUiTestFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(filePath) {
  return relative(packageRoot, filePath).split(sep).join('/');
}

function manifestHash(files) {
  const manifest = files.map(normalizeRelativePath).join('\n');
  return createHash('sha256').update(manifest).digest('hex');
}

function runTsx(testFiles, extraArgs) {
  const tsxEntrypoint = join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxEntrypoint)) {
    throw new Error(`tsx entrypoint not found: ${tsxEntrypoint}`);
  }

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(
      process.execPath,
      [
        tsxEntrypoint,
        '--no-warnings=ExperimentalWarning',
        ...extraArgs,
        '--test',
        ...testFiles,
      ],
      {
        cwd: packageRoot,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
    );

    child.once('error', rejectProcess);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectProcess(new Error(`tsx exited after receiving ${signal}`));
      } else {
        resolveProcess(code ?? 1);
      }
    });
  });
}

const testFiles = (await discoverUiTestFiles(uiRoot))
  .sort(comparePaths);
const manifest = manifestHash(testFiles);
console.log(`[test:ui] discovered ${testFiles.length} test files (manifest ${manifest})`);

if (testFiles.length <= uiTestFileCountBaseline) {
  throw new Error(
    `[test:ui] discovery found ${testFiles.length} files; expected more than ${uiTestFileCountBaseline}`,
  );
}

const exitCode = await runTsx(testFiles, process.argv.slice(2));
process.exitCode = exitCode;
