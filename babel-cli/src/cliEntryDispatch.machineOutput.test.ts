/** UX-12 — promised machine output must exist on stdout for failures too. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { requestedMachineOutput, writeCliFailure } from './cliEntryDispatch.js';

test('UX-12: structured output flags are recognized', () => {
  assert.equal(requestedMachineOutput(['node', 'babel', 'run', 'x', '--json']), 'json');
  assert.equal(requestedMachineOutput(['node', 'babel', 'run', 'x', '--output-format', 'stream-json']), 'ndjson');
  assert.equal(requestedMachineOutput(['node', 'babel', 'run', 'x', '--output-format=jsonl']), 'ndjson');
  assert.equal(requestedMachineOutput(['node', 'babel', 'run', 'x', '--output-format=ndjson']), 'ndjson');
  assert.equal(requestedMachineOutput(['node', 'babel', 'run', 'x']), null);
});

test('UX-12: a JSON failure is one parseable stdout object', () => {
  let written = '';
  writeCliFailure(
    ['node', 'babel', 'run', 'x', '--json'],
    'provider unavailable',
    (line) => {
      written += line;
    },
  );
  const parsed = JSON.parse(written) as Record<string, unknown>;
  assert.equal(parsed['status'], 'error');
  assert.equal(parsed['message'], 'provider unavailable');
});

test('UX-12: an NDJSON failure is one parseable stdout line', () => {
  let written = '';
  writeCliFailure(
    ['node', 'babel', 'run', 'x', '--output-format', 'stream-json'],
    'provider unavailable',
    (line) => {
      written += line;
    },
  );
  const lines = written.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed['type'], 'run_error');
  assert.equal(parsed['status'], 'EXECUTOR_HALTED');
  assert.equal(parsed['error'], 'provider unavailable');
});

test('UX-12 integration: clean-profile NDJSON failure still writes stdout JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'babel-ux12-'));
  try {
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', entry, 'definitely-not-a-command', '--output-format', 'stream-json'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          BABEL_CONFIG_DIR: home,
          BABEL_RUNS_DIR: join(home, 'runs'),
        },
      },
    );
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 1, child.stderr);
    const first = String(child.stdout).trim().split('\n')[0];
    assert.ok(first, `stdout must not be empty on failure (stderr=${child.stderr})`);
    const parsed = JSON.parse(first!) as Record<string, unknown>;
    assert.equal(parsed['type'], 'run_error');
    assert.equal(parsed['status'], 'EXECUTOR_HALTED');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
