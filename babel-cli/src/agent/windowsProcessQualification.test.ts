/** Real Windows execution qualification for the background/await command path. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import test from 'node:test'

import {
  awaitBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './backgroundShell.js'
import { ProcessWitness } from '../diagnostics/bdns/processWitness.js'
import { SafeExecutor } from '../sandbox.js'
import { parseCommandArgv, quoteWindowsCommandArg } from '../utils/commandArgv.js'

const windowsOnly = process.platform === 'win32' ? {} : { skip: 'Windows-only process qualification' }

test('Windows executes spaced .exe, .cmd, and .bat paths with exact child argv and cwd', windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-windows-process-'))
  const cwd = join(root, 'cwd with spaces')
  mkdirSync(cwd)
  const echoScript = join(root, 'echo argv.cjs')
  writeFileSync(
    echoScript,
    'process.stdout.write(JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath}))',
    'utf8',
  )

  const cmdWrapper = join(root, 'wrapper with spaces.cmd')
  const batWrapper = join(root, 'wrapper with spaces.bat')
  for (const wrapper of [cmdWrapper, batWrapper]) {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${echoScript}" %*\r\n`, 'utf8')
  }

  const childArgs = ['arg with spaces', '', 'C:\\ending\\', 'a"b']
  const cases: Array<{ name: string; executable: string; argv: string[] }> = [
    { name: 'exe', executable: process.execPath, argv: [echoScript, ...childArgs] },
    { name: 'cmd', executable: cmdWrapper, argv: childArgs },
    { name: 'bat', executable: batWrapper, argv: childArgs },
  ]

  try {
    for (const scenario of cases) {
      const command = [scenario.executable, ...scenario.argv]
        .map(quoteWindowsCommandArg)
        .join(' ')
      const authorizedArgv = parseCommandArgv(command, 'win32')
      assert.deepEqual(authorizedArgv, [scenario.executable, ...scenario.argv], scenario.name)

      const witness = new ProcessWitness()
      const job = startBackgroundShell({
        command,
        cwd,
        timeoutMs: 10_000,
        toolCallId: `windows-${scenario.name}`,
        processWitness: witness,
      })
      const result = await awaitBackgroundShell(job.id, 10_000)
      assert.equal(result.status, 'completed', `${scenario.name}: ${result.stderr}`)
      assert.equal(result.exit_code, 0, `${scenario.name}: ${result.stderr}`)

      const observed = JSON.parse(result.stdout) as {
        argv: string[]
        cwd: string
        execPath: string
      }
      assert.deepEqual(observed.argv, childArgs, scenario.name)
      assert.equal(normalize(observed.cwd).toLowerCase(), normalize(resolve(cwd)).toLowerCase(), scenario.name)
      assert.equal(normalize(observed.execPath).toLowerCase(), normalize(process.execPath).toLowerCase(), scenario.name)

      const [record] = witness.list()
      assert.ok(record, `${scenario.name}: missing process witness`)
      assert.match(record.payload.executable, /(?:^|[\\/])cmd\.exe$/iu)
      assert.deepEqual(record.payload.args.slice(0, 3), ['/d', '/s', '/c'])
      assert.match(record.payload.args[3] ?? '', /wrapper with spaces\.(?:cmd|bat)|node\.exe/iu)
      assert.equal(record.payload.timeoutMs, 10_000)
      await witness.close()
    }
  } finally {
    resetBackgroundShellRegistryForTests()
  }
})

test('Windows foreground shell preserves the same command identity for sync and async execution', windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-windows-foreground-'))
  const cwd = join(root, 'cwd with spaces')
  mkdirSync(cwd)
  const echoScript = join(root, 'echo argv.cjs')
  writeFileSync(
    echoScript,
    'process.stdout.write(JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath}))',
    'utf8',
  )
  const childArgs = ['arg with spaces', '', 'C:\\ending\\', 'a"b']
  const command = [process.execPath, echoScript, ...childArgs]
    .map(quoteWindowsCommandArg)
    .join(' ')
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE']
  const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK']
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'

  try {
    const executor = new SafeExecutor(root)
    const results = [
      executor.shellExec(command, cwd, 10_000),
      await executor.shellExecAsync(command, cwd, 10_000),
    ]
    for (const result of results) {
      assert.equal(result.exit_code, 0, result.stderr)
      const observed = JSON.parse(result.stdout) as {
        argv: string[]
        cwd: string
        execPath: string
      }
      assert.deepEqual(observed.argv, childArgs)
      assert.equal(normalize(observed.cwd).toLowerCase(), normalize(resolve(cwd)).toLowerCase())
      assert.equal(normalize(observed.execPath).toLowerCase(), normalize(process.execPath).toLowerCase())
    }
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile
    if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK']
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback
  }
})
