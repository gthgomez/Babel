// License: Apache-2.0
// Independent oracle for the same small arithmetic repair used by installed_mechanics.mjs.
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const BUGGY_PARSER = 'export const add = (a, b) => a - b\n';
export const FIXED_PARSER = 'export const add = (a, b) => a + b\n';
const TEST_SOURCE = "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from './parser.mjs'\n" +
  'for (const [a,b] of [[1,2],[7,4],[-2,5],[0,9]]) test(`add(${a},${b})`, () => assert.equal(add(a,b),a+b))\n';

function fixtureEnvironment(project) {
  const home = join(dirname(project), 'repair-fixture-home');
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TEMP: home, TMP: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'absent-gitconfig'), GIT_TERMINAL_PROMPT: '0'};
}

function command(project, executable, args) {
  const result = spawnSync(executable, args, {cwd: project, env: fixtureEnvironment(project), encoding: 'utf8',
    timeout: 30_000, windowsHide: true});
  if (result.error || result.status === null) throw new Error('repair fixture command could not complete');
  return {status: result.status, output: result.stdout};
}

function git(project, args) {
  const home = join(dirname(project), 'repair-fixture-home');
  const result = command(project, 'git', ['-c', `core.hooksPath=${home}`, '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false', ...args]);
  if (result.status !== 0) throw new Error('repair fixture Git command failed');
  return result.output;
}

function independentTest(project) {
  const result = command(project, process.execPath, ['--test', '--test-reporter=tap', 'verify.mjs']);
  if (!/^# tests 4\r?$/m.test(result.output)) throw new Error('independent test did not report four cases');
  return result;
}

/** Create a disposable Git project with the installed CLI mechanics arithmetic fixture. */
export async function createRepairFixture(project) {
  await mkdir(project, {recursive: true});
  await mkdir(join(dirname(project), 'repair-fixture-home'), {recursive: true});
  await writeFile(join(project, 'README.md'), '# Packaged acceptance fixture\n', 'utf8');
  await writeFile(join(project, 'parser.mjs'), BUGGY_PARSER, 'utf8');
  await writeFile(join(project, 'verify.mjs'), TEST_SOURCE, 'utf8');
  await writeFile(join(project, 'package.json'), JSON.stringify({name: 'installed-mechanics-fixture', private: true,
    scripts: {test: 'node --test --test-reporter=tap verify.mjs'}}) + '\n', 'utf8');
  git(project, ['init', '--quiet']);
  git(project, ['config', 'user.email', 'fixture@example.test']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['add', '--', 'README.md', 'parser.mjs', 'verify.mjs', 'package.json']);
  git(project, ['commit', '--quiet', '-m', 'fixture baseline']);
}

/** Verify the intentionally failing test and an unchanged, clean fixture. */
export async function assertRepairBaseline(project) {
  const result = independentTest(project);
  if (result.status !== 1 || !/^# fail 4\r?$/m.test(result.output) ||
      await readFile(join(project, 'parser.mjs'), 'utf8') !== BUGGY_PARSER ||
      git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) !== '') {
    throw new Error('repair baseline is not the expected clean failing fixture');
  }
  return {testExit: result.status, tests: 4, failed: 4, clean: true};
}

/** Verify real test execution and the exact one-file Git diff independently of Babel. */
export async function assertRepairComplete(project) {
  const result = independentTest(project);
  if (result.status !== 0 || !/^# pass 4\r?$/m.test(result.output) || !/^# fail 0\r?$/m.test(result.output)) {
    throw new Error('independent test did not pass all four cases');
  }
  const status = git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = git(project, ['diff', '--no-ext-diff', '--numstat', '--', 'parser.mjs']);
  const patch = git(project, ['diff', '--no-ext-diff', '--', 'parser.mjs']);
  if (status !== ' M parser.mjs\0' || !/^1\s+1\s+parser\.mjs\r?\n$/.test(diff) ||
      await readFile(join(project, 'parser.mjs'), 'utf8') !== FIXED_PARSER) {
    throw new Error('repair produced an unexpected scoped diff');
  }
  return {testExit: result.status, tests: 4, passed: 4, diff: {path: 'parser.mjs', additions: 1, deletions: 1}, patch};
}
