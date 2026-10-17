import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recordInteractiveDiagnostic, interactiveDiagnosticPath } from './interactiveDiagnostics.js';
import * as warmup from '../interactive/replWarmup.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';

test('interactive diagnostics are local files and do not enter terminal output', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ui-diagnostic-'));
  const prior = process.env.BABEL_STATE_DIR;
  process.env.BABEL_STATE_DIR = root;
  try {
    assert.equal(recordInteractiveDiagnostic('startup', 'daemon ready'), true);
    const record = JSON.parse(readFileSync(interactiveDiagnosticPath(), 'utf8'));
    assert.equal(record.channel, 'startup');
    assert.equal(record.message, 'daemon ready');
    recordInteractiveDiagnostic('startup', 'password=fixture-value');
    const stored = readFileSync(interactiveDiagnosticPath(), 'utf8');
    assert.equal(stored.includes('fixture-value'), false);
  } finally { if (prior === undefined) delete process.env.BABEL_STATE_DIR; else process.env.BABEL_STATE_DIR = prior; }
});

test('interactive launcher redirects Node warnings before imports and propagates exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-warning-route-'));
  const fixture = join(root, 'fixture.mjs');
  const route = pathToFileURL(resolve('src/cli/interactiveWarningRoute.ts')).href;
  writeFileSync(fixture, `import { routeInteractiveWarnings } from ${JSON.stringify(route)};\nif (!(await routeInteractiveWarnings({isTTY:true}))) { process.emitWarning('synthetic WASM warning'); console.log('response only'); process.exitCode=7; }\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, BABEL_STATE_DIR: root };
  delete env.NODE_REDIRECT_WARNINGS;
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout.trim(), 'response only');
  assert.equal(result.stderr, '');
  const logs = readdirSync(join(root, 'diagnostics'));
  assert.equal(logs.length, 1);
  assert.match(readFileSync(join(root, 'diagnostics', logs[0]!), 'utf8'), /synthetic WASM warning/);
});

test('startup failure retains a redacted actionable error when its diagnostic log cannot be written', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-diagnostic-unwritable-'));
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'fixture');
  const prior = process.env.BABEL_STATE_DIR;
  process.env.BABEL_STATE_DIR = file;
  const task = backgroundTaskRegistry.register('Synthetic daemon startup');
  try {
    warmup.reportWarmupFailure(task, new Error('\x1b[31mPort unavailable; password=fixture-value'));
    const failed = backgroundTaskRegistry.getAllTasks().find((entry) => entry.id === task);
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error ?? '', /Port unavailable/);
    assert.match(failed?.error ?? '', /diagnostic log unavailable/);
    assert.doesNotMatch(failed?.error ?? '', /fixture-value/);
    assert.doesNotMatch(failed?.error ?? '', /\x1b/);
  } finally {
    if (prior === undefined) delete process.env.BABEL_STATE_DIR; else process.env.BABEL_STATE_DIR = prior;
  }
});

test('an unavailable warning directory does not abort interactive startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-warning-unwritable-'));
  const file = join(root, 'not-a-directory'); writeFileSync(file, 'fixture');
  const fixture = join(root, 'fixture.mjs');
  const route = pathToFileURL(resolve('src/cli/interactiveWarningRoute.ts')).href;
  writeFileSync(fixture, `import * as route from ${JSON.stringify(route)}; const result=await route.routeInteractiveWarnings({isTTY:true,argv:['node',process.argv[1]]}); console.log(JSON.stringify({result,failure:route.getWarningRouteFailure()}));`);
  const env: NodeJS.ProcessEnv = { ...process.env, BABEL_STATE_DIR: file };
  delete env.NODE_OPTIONS; delete env.NODE_REDIRECT_WARNINGS; delete env.BABEL_HEADLESS;
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.result, false);
  assert.match(report.failure, /directory unavailable/);
});
