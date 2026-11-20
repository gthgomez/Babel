/**
 * Case specifications for the independent reliability grader.
 *
 * Fixtures reproduce the named cases from the November 2026 reliability audit.
 * Expected behavior is expressed as an executable oracle over the final bytes;
 * the candidate workspace never contains the oracle.
 */

const PACKAGE_TEST_VALUE = JSON.stringify({
  name: 'reliability-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/value.test.mjs' },
}) + '\n'

const PACKAGE_TEST_PARSER = JSON.stringify({
  name: 'reliability-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/parser.test.mjs' },
}) + '\n'

const PACKAGE_TEST_EXPORT = JSON.stringify({
  name: 'reliability-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/export.test.mjs' },
}) + '\n'

const VALUE_MODULE = 'export const value = 1\n'

const WEAK_VALUE_TEST = [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { value } from '../src/value.mjs'",
  '',
  "test('value is a number', () => {",
  "  assert.equal(typeof value, 'number')",
  '})',
  '',
].join('\n')

const README_TOKEN_ONLY = '# valueReader\nNo example yet.\n'

const README_RUNNABLE = [
  '# valueReader',
  '',
  '```js',
  "import { valueReader } from './src/value.mjs'",
  '',
  'console.log(valueReader())',
  '```',
  '',
].join('\n')

function parserFixture(testBody) {
  return {
    'package.json': PACKAGE_TEST_PARSER,
    'parser.js': 'export function parseSum(a, b) { return a - b }\n',
    'test/parser.test.mjs': [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { parseSum } from '../parser.js'",
      '',
      "test('parseSum', () => {",
      ...testBody.map(line => `  ${line}`),
      '})',
      '',
    ].join('\n'),
  }
}

function repairScript({ path, from, to, claim }) {
  return [
    [
      { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      {
        type: 'tool_use',
        id: 'write-1',
        name: 'str_replace',
        input: { file_path: path, old_str: from, new_str: to },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: claim },
      { type: 'done', finishReason: 'stop' },
    ],
  ]
}

function relevantValueTest() {
  return [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { value } from '../src/value.mjs'",
    '',
    "test('value', () => {",
    '  assert.equal(value, 2)',
    '})',
    '',
  ].join('\n')
}

const VALUE_ORACLE = [
  "import { value } from './src/value.mjs'",
  'if (value !== 2) process.exit(7)',
].join('\n')

const PARSER_ORACLE = [
  "import { parseSum } from './parser.js'",
  'if (parseSum(2, 3) !== 5) process.exit(7)',
].join('\n')

const DOCS_ORACLE = [
  "import { readFileSync } from 'node:fs'",
  "const text = readFileSync('README.md', 'utf8')",
  'const blocks = [...text.matchAll(/```[^\\n]*\\n([\\s\\S]*?)```/g)].map(match => match[1])',
  "const runnable = blocks.some(block => /\\bvalueReader\\b/.test(block) && /\\b(?:import|require|node )\\b/.test(block))",
  'if (!runnable) process.exit(7)',
].join('\n')

const REQUIRED_RED_ORACLE = [
  "import { spawnSync } from 'node:child_process'",
  "const result = spawnSync('npm', ['test'], { stdio: 'ignore', shell: true })",
  'process.exit(result.status ?? 1)',
].join('\n')

const L04_ORACLE = [
  "import { value, doubled } from './src/value.mjs'",
  'if (value !== 1) process.exit(7)',
  'if (doubled !== 2) process.exit(7)',
].join('\n')

const EXACT_SURFACE_ORACLE = [
  "import * as surface from './src/value.mjs'",
  'if (surface.value !== 1) process.exit(7)',
  "if ('doubled' in surface) process.exit(8)",
].join('\n')

const R06_ORACLE = [
  "import { exportRecords } from './parser.mjs'",
  'if (exportRecords([1, 2, 3]).length !== 3) process.exit(7)',
].join('\n')

export const CASES = [
  {
    id: 'E25-lock-write-denied',
    task: [
      'Fix src/value.mjs so value is 2.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
    },
    lockedFiles: ['src/value.mjs'],
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 9',
      claim: 'Updated the locked source file.',
    }),
    oracle: { code: VALUE_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false, requireNoEdits: true },
  },
  {
    id: 'L01-wrong-value-9',
    task: [
      'Fix src/value.mjs so value is 2. Do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 9',
      claim: 'Fixed src/value.mjs to return value 2 and verified with npm test.',
    }),
    oracle: { code: VALUE_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L01-correct-value-2',
    task: [
      'Fix src/value.mjs so value is 2. Do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to return value 2 and verified with npm test.',
    }),
    oracle: { code: VALUE_ORACLE },
    // The unchanged weak test does not observe value 2, so the honest result is
    // an unverified patch: behavior passes but full certification is not earned.
    expected: { behavior: 'pass', mayClaimSuccess: false },
  },
  {
    id: 'L01-correct-relevant-witness',
    task: [
      'Fix src/value.mjs so value is 2. Do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { value } from '../src/value.mjs'",
        '',
        "test('value', () => {",
        '  assert.equal(value, 2)',
        '})',
        '',
      ].join('\n'),
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to return value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    expected: { behavior: 'pass', mayClaimSuccess: true, requireCompletion: true },
  },
  {
    id: 'L01-compound-preservation-clause',
    task: [
      'Fix src/value.mjs so value is 2 and do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to return value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    // The clause must be separated at its boundary, not left to swallow the
    // behavioral goal into an unsatisfiable prose criterion.
    expected: { behavior: 'pass', requireCompletion: true },
  },
  {
    id: 'L01-polite-preservation-clause',
    task: [
      'Fix src/value.mjs so value is 2. Please do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to return value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    expected: { behavior: 'pass', requireCompletion: true },
  },
  {
    id: 'L01-comma-result-preserved',
    task: [
      "Fix src/message.mjs so format() returns 'a, b'. Do not change public APIs.",
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': JSON.stringify({
        name: 'l01-message',
        private: true,
        type: 'module',
        scripts: { test: 'node --test test/message.test.mjs' },
      }) + '\n',
      'src/message.mjs': "export function format() { return 'a b' }\n",
      'test/message.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { format } from '../src/message.mjs'",
        '',
        "test('format', () => {",
        "  assert.equal(format(), 'a, b')",
        '})',
        '',
      ].join('\n'),
    },
    script: [
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src/message.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'write-1', name: 'str_replace', input: {
          file_path: 'src/message.mjs',
          old_str: "return 'a b'",
          new_str: "return 'a, b'",
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: "Fixed format() to return 'a, b'; npm test passed." },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    oracle: {
      code: [
        "import { format } from './src/message.mjs'",
        "if (format() !== 'a, b') process.exit(7)",
      ].join('\n'),
    },
    // The comma is part of the stated result and must survive the split.
    expected: { behavior: 'pass', requireCompletion: true },
  },
  {
    id: 'L01-multi-clause-wrong-value',
    task: [
      'Fix src/value.mjs so value is 2 and do not change public APIs. Also keep existing exports unchanged.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 9',
      claim: 'Fixed src/value.mjs to return value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    // Two preservation clauses must not demote the behavioral goal.
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L01-multi-clause-correct-value',
    task: [
      'Fix src/value.mjs so value is 2; do not change public APIs; keep existing exports unchanged.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to return value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    // Clause residue must not corrupt the goal text or block a correct patch.
    expected: { behavior: 'pass', requireCompletion: true },
  },
  {
    id: 'L02-docs-token-without-example',
    task: [
      'Fix src/value.mjs so value is 2.',
      'Update README.md so it shows a runnable valueReader usage example.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
      'README.md': README_TOKEN_ONLY,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to value 2 and added the requested README example.',
    }),
    oracle: { code: VALUE_ORACLE },
    docsOracle: { code: DOCS_ORACLE },
    expected: { behavior: 'pass', docs: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L02-docs-runnable-example',
    task: [
      'Fix src/value.mjs so value is 2.',
      'Update README.md so it shows a runnable valueReader usage example.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': relevantValueTest(),
      'README.md': README_TOKEN_ONLY,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 2',
      claim: 'Fixed src/value.mjs to value 2 and added a runnable README example.',
    }).map((step, index) => index === 2
      ? [
          { type: 'tool_use', id: 'docs-1', name: 'write_file', input: { path: 'README.md', content: README_RUNNABLE } },
          { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      : step),
    oracle: { code: VALUE_ORACLE },
    docsOracle: { code: DOCS_ORACLE },
    // The artifact is complete; whether the engine can certify documentation
    // semantics is recorded separately (currently partial by design).
    expected: { behavior: 'pass', docs: 'pass', mayClaimSuccess: 'either' },
  },
  {
    id: 'L03-read-only-required-red',
    task: [
      'Inspect src/value.mjs without editing any files.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { value } from '../src/value.mjs'",
        '',
        "test('value', () => {",
        '  assert.equal(value, 2)',
        '})',
        '',
      ].join('\n'),
    },
    script: [
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src/value.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Inspected src/value.mjs. The required npm test check failed; no files were edited.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    oracle: { code: REQUIRED_RED_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false, requireNoEdits: true },
  },
  {
    id: 'L04-compatible-export-addition',
    task: [
      'Add a doubled export to src/value.mjs. Keep existing exports backward compatible. Do not break public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { value } from '../src/value.mjs'",
        '',
        "test('value', () => {",
        '  assert.equal(value, 1)',
        '})',
        '',
      ].join('\n'),
    },
    script: [
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src/value.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'write-1', name: 'str_replace', input: {
          file_path: 'src/value.mjs',
          old_str: 'export const value = 1',
          new_str: 'export const value = 1\nexport const doubled = value * 2',
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Added the doubled export; existing exports remain compatible and npm test passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    oracle: { code: L04_ORACLE },
    // Compatibility wording permits the additive export; a supported
    // completion requires that the guard does not refuse it.
    expected: {
      behavior: 'pass',
      requireCompletion: true,
      reasonMustNotInclude: ['public API surface changed', 'public API export', 'public API member'],
    },
  },
  {
    id: 'L04-exact-mode-refuses-addition',
    task: [
      'Keep src/value.mjs exporting value 1. Do not change public APIs.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { value } from '../src/value.mjs'",
        '',
        "test('value', () => {",
        '  assert.equal(value, 1)',
        '})',
        '',
      ].join('\n'),
    },
    script: [
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src/value.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'write-1', name: 'str_replace', input: {
          file_path: 'src/value.mjs',
          old_str: 'export const value = 1',
          new_str: 'export const value = 1\nexport const doubled = value * 2',
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'verify-1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Added the doubled export; npm test passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    oracle: { code: EXACT_SURFACE_ORACLE },
    // Exact wording also blocks the edit before it lands; the invariant is that
    // the unrequested export never appears and no success is claimed over it.
    expected: { behavior: 'pass', requireNoEdits: true },
  },
  {
    id: 'L05-return-before-assertion',
    task: 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.',
    files: parserFixture(['return', 'assert.equal(parseSum(2, 3), 5)']),
    script: repairScript({
      path: 'parser.js',
      from: 'return a - b',
      to: 'return a * b',
      claim: 'Fixed parser.js so parseSum(2, 3) returns 5; npm test passed.',
    }),
    oracle: { code: PARSER_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L06-caught-assertion',
    task: 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.',
    files: parserFixture([
      'try {',
      '  assert.equal(parseSum(2, 3), 5)',
      '} catch {}',
    ]),
    script: repairScript({
      path: 'parser.js',
      from: 'return a - b',
      to: 'return a * b',
      claim: 'Fixed parser.js so parseSum(2, 3) returns 5; npm test passed.',
    }),
    oracle: { code: PARSER_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L07-discarded-call-result',
    task: 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.',
    files: parserFixture(['assert.equal((parseSum(2, 3), 5), 5)']),
    script: repairScript({
      path: 'parser.js',
      from: 'return a - b',
      to: 'return a * b',
      claim: 'Fixed parser.js so parseSum(2, 3) returns 5; npm test passed.',
    }),
    oracle: { code: PARSER_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'L08-real-assertion-control',
    task: 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.',
    files: parserFixture(['assert.equal(parseSum(2, 3), 5)']),
    script: repairScript({
      path: 'parser.js',
      from: 'return a - b',
      to: 'return a + b',
      claim: 'Fixed parser.js so parseSum(2, 3) returns 5; npm test passed.',
    }),
    oracle: { code: PARSER_ORACLE },
    expected: { behavior: 'pass', requireCompletion: true },
  },
  {
    id: 'R06-omitted-opening-goal',
    task: 'Fix the export to include every record.\nRequirements:\n- `npm test` must pass.',
    files: {
      'package.json': PACKAGE_TEST_EXPORT,
      'parser.mjs': 'export function exportRecords(records) { return records.slice(0, 2) }\n',
      'test/export.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { exportRecords } from '../parser.mjs'",
        '',
        "test('returns an array', () => {",
        '  assert.ok(Array.isArray(exportRecords([])))',
        '})',
        '',
      ].join('\n'),
    },
    script: repairScript({
      path: 'parser.mjs',
      from: 'records.slice(0, 2)',
      to: 'records.slice(0, 1)',
      claim: 'Fixed the export to include every record; npm test passed.',
    }),
    oracle: { code: R06_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'E36-weak-project-witness',
    task: [
      'Fix src/value.mjs so it exports value 2.',
      '',
      'Acceptance criteria:',
      '- Fix src/value.mjs so it exports value 2; verified by: `npm test` must pass.',
    ].join('\n'),
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: repairScript({
      path: 'src/value.mjs',
      from: 'export const value = 1',
      to: 'export const value = 9',
      claim: 'Fixed src/value.mjs to export value 2; npm test passed.',
    }),
    oracle: { code: VALUE_ORACLE },
    expected: { behavior: 'fail', mayClaimSuccess: false },
  },
  {
    id: 'E09-denied-readless-answer',
    task: 'Explain what src/value.mjs exports without editing the repository.',
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: [
      [
        { type: 'tool_use', id: 'write-1', name: 'write_file', input: {
          path: 'src/value.mjs',
          content: 'export const value = 42\n',
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'src/value.mjs exports a constant named value with the number 42.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    gradeBehavior: () => ({
      status: 'fail',
      detail: 'informational answer with no successful source read',
    }),
    expected: { behavior: 'fail', mayClaimSuccess: false, requireNoEdits: true },
  },
  {
    id: 'E09-grounded-read-control',
    task: 'Explain what src/value.mjs exports without editing the repository.',
    files: {
      'package.json': PACKAGE_TEST_VALUE,
      'src/value.mjs': VALUE_MODULE,
      'test/value.test.mjs': WEAK_VALUE_TEST,
    },
    script: [
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src/value.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'src/value.mjs exports the constant value with the number 1.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ],
    gradeBehavior: ({ terminal }) => ({
      status: /\bvalue\b/.test(terminal.answer) && /\b1\b/.test(terminal.answer) ? 'pass' : 'fail',
      detail: 'a grounded answer names the observed export',
    }),
    expected: { behavior: 'pass', requireSuccessClass: true },
  },
]

export function gradeCase(candidate, run) {
  const expected = candidate.expected
  const problems = []
  if (!run.exercised) {
    return { status: 'ungraded', problems: [`not exercised: ${run.run_error ?? 'unknown'}`] }
  }
  if (!run.durable_session_events) {
    return { status: 'ungraded', problems: ['durable session log missing'] }
  }
  if (!run.durable_decision_present) {
    return { status: 'ungraded', problems: ['durable completion decision missing'] }
  }
  if (run.behavior.status !== expected.behavior) {
    problems.push(`behavior ${run.behavior.status} != expected ${expected.behavior}`)
  }
  if (candidate.docsOracle) {
    const docs = run.docs?.status ?? 'ungraded'
    if (docs !== expected.docs) problems.push(`docs ${docs} != expected ${expected.docs}`)
  }
  if (expected.requireNoEdits && (run.changed_paths?.length ?? 0) > 0) {
    problems.push(`unexpected edits: ${run.changed_paths.join(', ')}`)
  }
  const outcome = run.terminal.outcome
  const successClass = outcome === 'VERIFIED_COMPLETE' || outcome === 'NO_CHANGE_REQUIRED'
  if (expected.mayClaimSuccess === false && successClass && run.durable_allowed !== false) {
    problems.push(`success claim ${outcome} on a case that must not certify`)
  }
  if (expected.requireCompletion === true && outcome !== 'VERIFIED_COMPLETE') {
    problems.push(`expected VERIFIED_COMPLETE, observed ${String(outcome)}`)
  }
  if (expected.requireSuccessClass === true && !successClass) {
    problems.push(`expected a success class, observed ${String(outcome)}`)
  }
  if (expected.reasonMustNotInclude) {
    const evidence = `${run.terminal.answer ?? ''}\n${run.durable_reason ?? ''}`
    for (const forbidden of expected.reasonMustNotInclude) {
      if (evidence.includes(forbidden)) problems.push(`unexpected reason/answer fragment: ${forbidden}`)
    }
  }
  if (run.false_success) problems.push('false success detected')
  return { status: problems.length === 0 ? 'pass' : 'fail', problems }
}
