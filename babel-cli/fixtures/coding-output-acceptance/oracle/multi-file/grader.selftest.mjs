#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(oracleRoot, '../../workspaces/multi-file');
const score = join(oracleRoot, 'score.mjs');

execFileSync(process.execPath, [join(oracleRoot, 'bootstrap-hashes.mjs')], { stdio: 'inherit' });

function copyTemplate() {
  const dir = mkdtempSync(join(tmpdir(), 'babel-multi-file-grader-'));
  cpSync(templateRoot, dir, { recursive: true });
  return dir;
}

function runScore(workspace) {
  try {
    execFileSync(process.execPath, [score, workspace], { stdio: 'pipe', windowsHide: true });
    return { status: 0 };
  } catch (error) {
    return { status: error && typeof error === 'object' && 'status' in error ? error.status ?? 1 : 1 };
  }
}

const unchanged = copyTemplate();
assert.notEqual(runScore(unchanged).status, 0, 'unchanged bug must fail independent invoke');

const emptyTests = copyTemplate();
writeFileSync(join(emptyTests, 'tests/greet.test.js'), '', 'utf8');
assert.notEqual(runScore(emptyTests).status, 0, 'emptied visible tests must fail hash guard');

const deletedTests = copyTemplate();
rmSync(join(deletedTests, 'tests/greet.test.js'));
assert.notEqual(runScore(deletedTests).status, 0, 'deleted visible tests must fail hash guard');

const commentOnly = copyTemplate();
writeFileSync(
  join(commentOnly, 'src/greet.ts'),
  readFileSync(join(commentOnly, 'src/greet.ts'), 'utf8') +
    '\n// Hello, ${name}! implementation looks fine\n',
);
assert.notEqual(runScore(commentOnly).status, 0, 'comment hardcoding must not satisfy invoke');

const valid = copyTemplate();
writeFileSync(
  join(valid, 'src/greet.ts'),
  `export const formatGreeting = (name: string): string => \`Hello, \${name}!\`;\n`,
);
writeFileSync(join(valid, 'src/index.ts'), `export { formatGreeting } from './greet.ts';\n`);
assert.equal(runScore(valid).status, 0, 'valid export behavior must pass');

for (const dir of [unchanged, emptyTests, deletedTests, commentOnly, valid]) {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ grader_selftest: 'pass' }));
