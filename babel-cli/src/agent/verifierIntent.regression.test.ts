import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCompletionVerificationContext } from './completionGatePolicy.js'
import { extractVerifierCommand } from './chatEngineVerifierSession.js'
import { extractRequiredVerifierCommandsFromTask } from '../pipeline/planVerifierInjection.js'

const nonMandatory = [
  'Fix the bug. Do not run tests.',
  'Fix the bug. Do not run npm test before completing.',
  "Fix the bug. Don't execute pytest.",
  'Fix the bug. Run tests if available; otherwise explain what could not run.',
  'Fix the bug. If available, run npm test.',
  'Fix the bug. Run npm test if available; otherwise report it unverified.',
  'Fix the bug. The README says "Run npm test before completing".',
  'Fix the bug. Example:\n```text\nRun npm test before completing.\n```',
  'Fix the bug. Example:\n> Run npm test before completing.',
  'Fix the bug. The old instruction was `Run npm test before completing`.',
]
for (const task of nonMandatory) test(`verification intent does not elevate evidence or optional instructions: ${task}`, () => {
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task, projectTestCommands: ['npm test'] })
  assert.equal(context.resolvedPolicy, 'required')
  assert.equal(context.mandatoryVerifierContract, false)
  assert.deepEqual(extractRequiredVerifierCommandsFromTask(task), [])
  assert.equal(extractVerifierCommand(task), null)
})

for (const task of [
  'Fix the bug. Run npm test before completing.',
  'Fix the bug. Run `npm test` before completing.',
  'Fix the bug. Do not edit docs, but run npm test before completing.',
  'Run tests if available. Verifier commands: npm test',
  'Example:\n```text\nDo not run tests.\n```\nRun npm test before completing.',
]) test(`explicit verifier requirement survives unrelated context: ${task}`, () => {
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task })
  assert.equal(context.mandatoryVerifierContract, true)
  assert.deepEqual(context.requiredVerifierCommands, ['npm test'])
})

test('host-bound verifier commands cannot be relaxed by task prose', () => {
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task: 'Run tests if available.', requiredVerifierCommands: ['npm test'] })
  assert.equal(context.mandatoryVerifierContract, true)
  assert.deepEqual(context.requiredVerifierCommands, ['npm test'])
})

for (const task of [
  'Run lint if available and run npm test before completing.',
  'Do not run lint and run npm test before completing.',
  'Run npm test before completing and inspect docs if available.',
  'Run npm test before completing and use the README if available.',
  'Run lint if available and you must run npm test before completing.',
  'Run npm test before completing and, if available, inspect docs.',
  'Run npm test before completing, then inspect docs if available.',
  'Run npm test before completing, using the README if available.',
  'Do not run lint, then run npm test before completing.',
]) test(`independent mandatory clause survives: ${task}`, () => {
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task })
  assert.equal(context.resolvedPolicy, 'strict')
  assert.deepEqual(context.requiredVerifierCommands, ['npm test'])
})

for (const command of ['npm test -- --grep "run tests"', 'npm test -- --grep "when available"']) {
  for (const formatted of [command, '`' + command + '`']) test(`verifier arguments remain literal: ${formatted}`, () => {
    const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task: `Verifier commands: ${formatted}` })
    assert.equal(context.mandatoryVerifierContract, true)
    assert.deepEqual(context.requiredVerifierCommands, [command])
  })
}

for (const separator of ['. ', '! ', '? ', '; ', '\n']) {
  test(`optional command cannot authorize a later quoted instruction across ${JSON.stringify(separator)}`, () => {
    const task = `Fix the bug. Run npm test if available${separator}The README says "Run npm test before completing".`
    const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task, projectTestCommands: ['npm test'] })
    assert.equal(context.resolvedPolicy, 'required')
    assert.deepEqual(context.requiredVerifierCommands, [])
    assert.equal(context.mandatoryVerifierContract, false)
    assert.equal(extractVerifierCommand(task), null)
    assert.deepEqual(extractRequiredVerifierCommandsFromTask(task), [])
  })
}

for (const command of [
  'npm test -- --grep "first. example" --grep "run tests"',
  'npm test -- --grep "first! example" --grep "when available"',
  'npm test -- --grep "first? example" --grep "run tests"',
]) test(`sentence punctuation inside command arguments stays literal: ${command}`, () => {
  const task = `Run lint if available. Verifier commands: ${command}`
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task })
  assert.deepEqual(context.requiredVerifierCommands, [command])
  assert.equal(context.mandatoryVerifierContract, true)
})

test('combined optional and quoted evidence cannot relax a later explicit or host-bound requirement', () => {
  const task = 'Run npm test if available. The README says "Run npm test before completing".'
  for (const context of [
    resolveCompletionVerificationContext({ taskClass: 'general_swe', task: task + ' Run pytest before completing.' }),
    resolveCompletionVerificationContext({ taskClass: 'general_swe', task, requiredVerifierCommands: ['pytest'] }),
  ]) {
    assert.deepEqual(context.requiredVerifierCommands, ['pytest'])
    assert.equal(context.mandatoryVerifierContract, true)
  }
})

for (const argument of ['run tests', 'when available']) test(`backticked command atom preserves quoted argument: ${argument}`, () => {
  const task = 'Run `npm test` -- --grep "' + argument + '" before completing.'
  const context = resolveCompletionVerificationContext({ taskClass: 'general_swe', task })
  assert.deepEqual(context.requiredVerifierCommands, ['npm test -- --grep "' + argument + '"'])
  assert.equal(context.mandatoryVerifierContract, true)
})
