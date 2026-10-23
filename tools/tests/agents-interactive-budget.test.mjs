import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  INTERACTIVE_STACK_BUDGET,
  assertInteractiveAgentsBudget,
  requiredIdentityLengthFromUtf8,
} from '../agents-interactive-budget.mjs'

test('committed UTF-8 bytes use UTF-16 code unit length like compileChatStack', () => {
  const path = fileURLToPath(new URL('../../AGENTS.md', import.meta.url))
  const bytes = readFileSync(path)
  const fromDisk = readFileSync(path, 'utf8').length
  assert.equal(requiredIdentityLengthFromUtf8(bytes), fromDisk)
  assert.ok(fromDisk <= INTERACTIVE_STACK_BUDGET)
  assertInteractiveAgentsBudget(bytes)
})

test('LF and CRLF bodies keep the same logical length after normalization variants', () => {
  const base = 'line\n'.repeat(100)
  const lf = Buffer.from(base, 'utf8')
  const crlf = Buffer.from(base.replace(/\n/g, '\r\n'), 'utf8')
  assert.notEqual(lf.length, crlf.length)
  assert.ok(assertInteractiveAgentsBudget(lf) < INTERACTIVE_STACK_BUDGET)
})

test('over-budget candidate fails before any TypeScript compile', () => {
  const body = 'x'.repeat(INTERACTIVE_STACK_BUDGET + 1)
  const bytes = Buffer.from(body, 'utf8')
  assert.throws(() => assertInteractiveAgentsBudget(bytes), /required_instruction_exceeds_prompt_budget/)
})

test('parity with focused chatStackCompile canonical guard tests', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx',
      '--import', './src/testinfra/register-no-ambient-inference.mjs',
      '--test',
      '--test-name-pattern=admits the complete canonical policy|renders canonical guards',
      'src/agent/chatStackCompile.test.ts',
    ],
    {
      cwd: fileURLToPath(new URL('../../babel-cli', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
