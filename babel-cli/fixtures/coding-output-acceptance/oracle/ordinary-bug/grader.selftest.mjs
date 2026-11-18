#!/usr/bin/env node
/**
 * Host self-test for the ordinary-bug oracle.
 *
 * Proves that behaviorally equivalent correct implementations pass and that
 * wrong implementations (including ones that are only wrong on negative or
 * fractional inputs) fail. The oracle never reads expected values from the
 * candidate workspace.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '../../workspaces/ordinary-bug');
const score = join(here, 'score.mjs');

const accepted = [
  ['canonical', 'export const add = (a, b) => a + b;\n'],
  ['commuted', 'export const add = (a, b) => b + a;\n'],
  ['block-body', 'export function add(a, b) { return a + b; }\n'],
  ['reduce', 'export const add = (...values) => values.reduce((sum, value) => sum + value, 0);\n'],
  ['numeric-coercion', 'export const add = (a, b) => Number(a) + Number(b);\n'],
  ['spread-sum', 'export function add(...values) { let total = 0; for (const value of values) total += value; return total; }\n'],
];

const rejected = [
  ['subtracts', 'export const add = (a, b) => a - b;\n'],
  ['negative-collapse', 'export const add = (a, b) => Math.abs(a) + b;\n'],
  ['wrong-on-negative', 'export const add = (a, b) => a + Math.abs(b);\n'],
  ['hardcoded-only-visible-case', 'export const add = (a, b) => (a === 1 && b === 2 ? 3 : 0);\n'],
  ['returns-string', 'export const add = (a, b) => String(a + b);\n'],
  ['throws-on-negative', 'export const add = (a, b) => { if (a < 0 || b < 0) throw new Error("negative"); return a + b; };\n'],
  ['not-a-function', 'export const add = 42;\n'],
  [
    'table-reading-spoof',
    `const expected = new Map()
for (const argument of process.argv) {
  try {
    const table = JSON.parse(argument)
    if (Array.isArray(table)) {
      for (const row of table) {
        if (Array.isArray(row) && row.length === 3) expected.set(row[0] + ',' + row[1], row[2])
      }
    }
  } catch {}
}
export const add = (a, b) => expected.has(a + ',' + b) ? expected.get(a + ',' + b) : (a === 1 && b === 2 ? 3 : a + Math.abs(b));
`,
  ],
  [
    'empty-stdout-report',
    `console.log('{}')
export const add = (a, b) => a - b;
`,
  ],
  [
    'exits-during-import',
    `process.exit(0)
export const add = (a, b) => a + b;
`,
  ],
  [
    'forged-stdout-report',
    `console.log(JSON.stringify({ cases: 11, failures: [] }))
export const add = (a, b) => a - b;
`,
  ],
  [
    'source-reading-spoof',
    `import { readFileSync } from 'node:fs'
const expected = new Map()
const remember = (table) => {
  if (!Array.isArray(table)) return
  for (const row of table) if (Array.isArray(row) && row.length === 3) expected.set(row[0] + ',' + row[1], row[2])
}
try {
  const args = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\\0')
  const scorePath = args.find((arg) => arg.endsWith('score.mjs'))
  if (scorePath) {
    const source = readFileSync(scorePath, 'utf8')
    const visible = source.match(/const visibleCases = (\[\[[\s\S]*?\]\])/)
    if (visible) remember(eval(visible[1]))
    for (const match of source.matchAll(/\[\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*\]/g)) {
      remember([[Number(match[1]), Number(match[2]), Number(match[3])]])
    }
  }
} catch {}
export const add = (a, b) => expected.has(a + ',' + b) ? expected.get(a + ',' + b) : (a === 1 && b === 2 ? 3 : a + Math.abs(b))
`,
  ],
  [
    'serializer-hijack',
    `const originalStringify = JSON.stringify
JSON.stringify = function (value, ...rest) {
  // Legacy report channel: replace the probe's failure report with a green one.
  if (value && typeof value === 'object' && ('failures' in value || 'observations' in value)) {
    return originalStringify.call(JSON, { cases: 11, failures: [] })
  }
  return originalStringify.call(JSON, value, ...rest)
}
Object.defineProperty(Object.prototype, 'toJSON', {
  configurable: true,
  value() { return this },
})
export const add = (a, b) => (a === 1 && b === 2 ? 3 : a - Math.abs(b))
`,
  ],
];

function runVariant(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-bug-selftest-'));
  try {
    cpSync(template, dir, { recursive: true });
    writeFileSync(join(dir, 'src/math.js'), contents, 'utf8');
    return spawnSync(process.execPath, [score, dir], { encoding: 'utf8', windowsHide: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, contents] of accepted) {
  const result = runVariant(contents);
  assert.equal(result.status, 0, `${name} should pass: ${result.stderr}`);
}
for (const [name, contents] of rejected) {
  const result = runVariant(contents);
  assert.notEqual(result.status, 0, `${name} should fail but passed`);
}

console.log(
  JSON.stringify({
    selftest: 'ordinary-bug',
    accepted: accepted.map(([name]) => name),
    rejected: rejected.map(([name]) => name),
  }),
);
