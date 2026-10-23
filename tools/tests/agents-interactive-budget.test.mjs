import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  INTERACTIVE_STACK_BUDGET,
  assertInteractiveAgentsBudget,
  requiredIdentityLengthFromUtf8,
} from '../agents-interactive-budget.mjs'

test('committed bytes match readFileSync utf8 length including preserved BOM', () => {
  const path = fileURLToPath(new URL('../../AGENTS.md', import.meta.url))
  const bytes = readFileSync(path)
  const fromDisk = readFileSync(path, 'utf8').length
  assert.equal(requiredIdentityLengthFromUtf8(bytes), fromDisk)
  assert.ok(fromDisk <= INTERACTIVE_STACK_BUDGET)
  assertInteractiveAgentsBudget(bytes)
})

test('UTF-8 BOM counts toward budget like compileChatStack readFileSync', () => {
  const bytes = Buffer.from('\ufeff' + 'x'.repeat(INTERACTIVE_STACK_BUDGET), 'utf8')
  assert.equal(requiredIdentityLengthFromUtf8(bytes), INTERACTIVE_STACK_BUDGET + 1)
  assert.throws(() => assertInteractiveAgentsBudget(bytes), /required_instruction_exceeds_prompt_budget/)
})

test('LF body at budget passes and one extra code unit fails', () => {
  const atBudget = Buffer.from('x'.repeat(INTERACTIVE_STACK_BUDGET), 'utf8')
  assert.equal(assertInteractiveAgentsBudget(atBudget), INTERACTIVE_STACK_BUDGET)
  const over = Buffer.from('x'.repeat(INTERACTIVE_STACK_BUDGET + 1), 'utf8')
  assert.throws(() => assertInteractiveAgentsBudget(over), /required_instruction_exceeds_prompt_budget/)
})

test('CRLF physical expansion is measured and can exceed LF-equivalent budget', () => {
  const lfBody = `${'a\n'.repeat(6000)}`
  assert.equal(lfBody.length, INTERACTIVE_STACK_BUDGET)
  assertInteractiveAgentsBudget(Buffer.from(lfBody, 'utf8'))
  const crlfBody = lfBody.replace(/\n/g, '\r\n')
  assert.ok(crlfBody.length > INTERACTIVE_STACK_BUDGET)
  assert.throws(
    () => assertInteractiveAgentsBudget(Buffer.from(crlfBody, 'utf8')),
    /required_instruction_exceeds_prompt_budget/,
  )
})

test('UTF-16 supplementary characters use surrogate-pair code units at boundary', () => {
  const emoji = '😀'
  assert.equal(emoji.length, 2)
  const body = emoji.repeat(INTERACTIVE_STACK_BUDGET / 2)
  assert.equal(body.length, INTERACTIVE_STACK_BUDGET)
  assertInteractiveAgentsBudget(Buffer.from(body, 'utf8'))
  assert.throws(
    () => assertInteractiveAgentsBudget(Buffer.from(emoji.repeat(INTERACTIVE_STACK_BUDGET / 2 + 1), 'utf8')),
    /required_instruction_exceeds_prompt_budget/,
  )
})

test('preflight budget matches compileChatStack for canonical LF and CRLF admission', () => {
  const agentsPath = fileURLToPath(new URL('../../AGENTS.md', import.meta.url))
  const source = readFileSync(agentsPath, 'utf8')
  for (const newline of ['\n', '\r\n']) {
    const policy = source.replace(/\r\n?/g, '\n').replace(/\n/g, newline)
    assert.ok(policy.length <= INTERACTIVE_STACK_BUDGET, `${newline === '\n' ? 'LF' : 'CRLF'} canonical must fit`)
    const root = mkdtempSync(join(tmpdir(), 'babel-agents-budget-parity-'))
    try {
      writeFileSync(join(root, 'AGENTS.md'), policy, 'utf8')
      const bytes = readFileSync(join(root, 'AGENTS.md'))
      assertInteractiveAgentsBudget(bytes)
      const result = spawnSync(
        process.execPath,
        [
          '--import', 'tsx',
          '--import', './src/testinfra/register-no-ambient-inference.mjs',
          '-e',
          `import { compileChatStack } from './src/agent/chatStackCompile.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[1];
const policy = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const stack = compileChatStack({ projectRoot: root, babelRoot: root, promptBudgetChars: ${INTERACTIVE_STACK_BUDGET}, includeDomainSkill: false });
if (stack.system_context.length > ${INTERACTIVE_STACK_BUDGET}) process.exit(2);
if (stack.system_context !== policy) process.exit(3);`,
          root,
        ],
        {
          cwd: fileURLToPath(new URL('../../babel-cli', import.meta.url)),
          encoding: 'utf8',
          windowsHide: true,
        },
      )
      assert.equal(result.status, 0, result.stderr || result.stdout)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('compileChatStack rejects the same CRLF overflow preflight rejects', () => {
  const lfBody = `${'a\n'.repeat(6000)}`
  const crlfBody = lfBody.replace(/\n/g, '\r\n')
  const root = mkdtempSync(join(tmpdir(), 'babel-agents-budget-overflow-'))
  try {
    writeFileSync(join(root, 'AGENTS.md'), crlfBody, 'utf8')
    assert.throws(
      () => assertInteractiveAgentsBudget(readFileSync(join(root, 'AGENTS.md'))),
      /required_instruction_exceeds_prompt_budget/,
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx',
        '--import', './src/testinfra/register-no-ambient-inference.mjs',
        '-e',
        `import { compileChatStack } from './src/agent/chatStackCompile.ts';
try { compileChatStack({ projectRoot: process.argv[1], babelRoot: process.argv[1], promptBudgetChars: ${INTERACTIVE_STACK_BUDGET}, includeDomainSkill: false }); process.exit(4); }
catch (e) { if (String(e).includes('required_instruction_exceeds_prompt_budget')) process.exit(0); throw e; }`,
        root,
      ],
      {
        cwd: fileURLToPath(new URL('../../babel-cli', import.meta.url)),
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
