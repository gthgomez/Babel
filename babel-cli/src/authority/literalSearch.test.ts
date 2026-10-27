import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeCommand } from './commandDecoder.js'
import { classifyExecutionRisk } from './commandSpec.js'
import { decideWithLease } from './wire.js'

for (const pattern of ['npm publish', 'DROP TABLE', '.env', 'curl', 'npm install']) {
  test(`literal rg pattern is data: ${pattern}`, () => {
    const command = `rg '${pattern}' README.md`
    const decoded = decodeCommand(command)
    assert.equal(decoded.capability, 'run_local_command')
    assert.equal(decoded.requiresIsolation, undefined)
    assert.equal(decideWithLease({ type: 'run_command', command }, 'workspace_write', { lease: null }).decision, 'allow')
    assert.equal(decideWithLease({ type: 'run_command', command }, 'read_only', { lease: null }).decision, 'deny')
    assert.equal(decideWithLease({ type: 'run_command', command }, 'ask_before_mutation', { lease: null }).decision, 'ask')
  })
}

for (const command of [
  "rg 'curl' secrets", "rg 'npm install' .aws", "rg 'curl' .ssh",
  "rg 'curl' ./secrets", "rg 'curl' ../secrets", "rg 'curl' nested/secrets",
  "rg 'curl' private.pem", "rg 'curl' private.key", "rg 'curl' .npmrc",
  'npm publish', 'cat .env', "rg 'ordinary' .env", "rg -f .env README.md",
  "rg --file=.env README.md", 'curl https://example.test', 'npm install package',
  "sh -c 'npm publish'", 'rg "$(npm publish)" README.md',
  'rg `npm publish` README.md', "rg ordinary README.md && npm publish",
]) {
  test(`real action or unsafe carrier stays denied: ${command}`, () => {
    assert.equal(decideWithLease({ type: 'run_command', command }, 'workspace_write', { lease: null }).decision, 'deny')
  })
}

for (const command of [
  "rg --pre 'printf benign' ordinary README.md",
  "rg --pre=helper ordinary README.md",
  'rg -z ordinary README.md',
  'rg --search-zip ordinary README.md',
]) {
  test(`external rg helper requires isolation: ${command}`, () => {
    assert.notEqual(classifyExecutionRisk(command).executionRisk, 'intrinsic')
    assert.equal(decideWithLease({ type: 'run_command', command }, 'workspace_write', { lease: null }).decision, 'deny')
  })
}

for (const command of [
  "rg -nF 'curl' README.md", "rg -e 'npm publish' README.md",
  "rg --regexp='.env' README.md", "rg -- '.env' README.md",
]) {
  test(`supported search spelling keeps pattern as data: ${command}`, () => {
    assert.equal(decideWithLease({ type: 'run_command', command }, 'workspace_write', { lease: null }).decision, 'allow')
  })
}

test('configured rg helpers keep the conservative permission and isolation boundary', () => {
  const previous = process.env['RIPGREP_CONFIG_PATH']
  try {
    process.env['RIPGREP_CONFIG_PATH'] = 'synthetic-unread-config'
    const command = "rg 'curl' README.md"
    assert.equal(classifyExecutionRisk(command).executionRisk, 'project_code')
    assert.equal(decideWithLease({ type: 'run_command', command }, 'workspace_write', { lease: null }).decision, 'deny')
  } finally {
    if (previous === undefined) delete process.env['RIPGREP_CONFIG_PATH']
    else process.env['RIPGREP_CONFIG_PATH'] = previous
  }
})
