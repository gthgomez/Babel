import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isWorkHelpRequest, workHelpText } from './workHelp.js';
import { createCliProgram } from '../cliMain.js';

function topLevelHelp(): string {
  const program = createCliProgram();
  let output = '';
  program.configureOutput({ writeOut: (text: string) => { output += text; } });
  program.outputHelp();
  return output;
}

test('work help describes the work verb instead of the advanced run lane', () => {
  assert.equal(isWorkHelpRequest(['node', 'babel.js', 'work', '--help']), true);
  assert.equal(isWorkHelpRequest(['node', 'babel.js', 'work', '-h']), true);
  assert.equal(isWorkHelpRequest(['node', 'babel.js', 'work', 'do it']), false);
  assert.equal(isWorkHelpRequest(['node', 'babel.js', 'run', '--help']), false);

  const text = workHelpText('babel');
  assert.match(text, /^Usage: babel work \[options\] <task>/);
  assert.doesNotMatch(text, /Usage: babel run/);
  assert.match(text, /--review <depth>/);
});

test('the published manifest exposes every documented executable name', () => {
  // UX-07: npm 0.2.0 shipped only babel-harness/babel-agent while docs used
  // `babel`. Keep the positive control so the alias cannot regress.
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { bin?: Record<string, string> };
  for (const name of ['babel', 'babel-agent', 'babel-harness']) {
    assert.equal(manifest.bin?.[name], 'bin/babel.js', `${name} points at the CLI entry`);
  }
});

test('top-level help names every installed executable alias', () => {  const help = topLevelHelp();
  assert.match(help, /babel and babel-agent are installed aliases/);
  assert.match(help, /continue latest/);
  // The mapped command is inspection-only; do not promise worker-chain resume.
  assert.doesNotMatch(help, /run resume <id>\s+Recover an execution worker chain/);
});
