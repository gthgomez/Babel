import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withInvocationSettings } from '../config/invocationSettings.js'

const managed = ['BABEL_STATE_DIR', 'BABEL_OFFLINE', 'BABEL_DESKTOP_PROVIDER', 'BABEL_MODEL', 'BABEL_PIPELINE_V9_OFFLINE', 'BABEL_LITE_OFFLINE'] as const
const saved = Object.fromEntries(managed.map(name => [name, process.env[name]]))

function restore(): void {
  for (const name of managed) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function runAdmission(args: string[]): Promise<boolean> {
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-offline-admission-'))
  const { createCliProgram } = await import('../cliMain.js')
  const { rewriteArgv } = await import('../cli/argv.js')
  const program = createCliProgram().exitOverride()
  let executed = false
  program.commands.find(command => command.name() === 'run')!.action(() => { executed = true })
  await withInvocationSettings({}, () => program.parseAsync(rewriteArgv(['node', 'babel-agent', ...args], new Set(program.commands.map(command => command.name())))))
  return executed
}

test.after(restore)

test('--offline admits a local-only run without requiring cloud setup', async () => {
  delete process.env['BABEL_OFFLINE']
  delete process.env['BABEL_DESKTOP_PROVIDER']
  delete process.env['BABEL_MODEL']
  assert.equal(await runAdmission(['run', 'Inspect locally', '--offline']), true)
})

test('a normal run still requires an explicit provider selection', async () => {
  delete process.env['BABEL_OFFLINE']
  delete process.env['BABEL_DESKTOP_PROVIDER']
  delete process.env['BABEL_MODEL']
  await assert.rejects(runAdmission(['run', 'Inspect remotely']), /SETUP_REQUIRED/)
})
