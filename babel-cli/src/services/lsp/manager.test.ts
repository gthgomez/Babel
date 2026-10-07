import assert from 'node:assert/strict'
import * as childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, mock, test } from 'node:test'

import { createLspServerManager } from './manager.js'

const mutableChildProcess = (childProcess as unknown as { default: typeof childProcess }).default
const temporaryRoots: string[] = []
const initialCwd = process.cwd()
const initialPath = process.env['PATH']

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-lsp-manager-'))
  temporaryRoots.push(root)
  return root
}

function setProject(root: string, pathValue = ''): void {
  process.chdir(root)
  process.env['PATH'] = pathValue
}

afterEach(() => {
  process.chdir(initialCwd)
  if (initialPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = initialPath
  mock.restoreAll()
  syncBuiltinESMExports()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('LSP server discovery', () => {
  test('missing TypeScript server is unavailable without invoking a child process', async () => {
    const root = project()
    setProject(root)
    let processCalls = 0
    mock.method(mutableChildProcess, 'execSync', (() => {
      processCalls += 1
      throw new Error('process execution blocked by test')
    }) as typeof childProcess.execSync)
    mock.method(mutableChildProcess, 'spawn', (() => {
      processCalls += 1
      throw new Error('process execution blocked by test')
    }) as typeof childProcess.spawn)
    mock.method(mutableChildProcess, 'spawnSync', (() => {
      processCalls += 1
      throw new Error('process execution blocked by test')
    }) as typeof childProcess.spawnSync)
    syncBuiltinESMExports()

    const manager = createLspServerManager()
    await manager.initialize()

    assert.equal(manager.getAllServers().size, 0)
    assert.equal(await manager.ensureServerForFile(join(root, 'src', 'index.ts')), null)
    assert.equal(processCalls, 0, 'discovery does not run npx, a server, or any child process')
  })

  test('recognizes an installed local TypeScript server without launching it', async () => {
    const root = project()
    setProject(root)
    const cli = join(root, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
    mkdirSync(join(root, 'node_modules', 'typescript-language-server', 'lib'), { recursive: true })
    writeFileSync(cli, '#!/usr/bin/env node\n')
    chmodSync(cli, 0o755)
    assert.equal(process.cwd(), root)
    assert.equal(existsSync(cli), true)

    const manager = createLspServerManager()
    await manager.initialize()

    assert.deepEqual([...manager.getAllServers().keys()], ['typescript'])
    const config = manager.getServer('typescript')?.config
    assert.equal(config?.command, cli)
    assert.deepEqual(config?.args, ['--stdio'])
  })

  test('recognizes an already-installed PATH binary without running a version probe', async () => {
    const root = project()
    const bin = join(root, 'bin')
    const binary = join(bin, 'typescript-language-server')
    mkdirSync(bin)
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    setProject(root, bin)
    let processCalls = 0
    mock.method(mutableChildProcess, 'execSync', (() => {
      processCalls += 1
      throw new Error('process execution blocked by test')
    }) as typeof childProcess.execSync)
    syncBuiltinESMExports()

    const manager = createLspServerManager()
    await manager.initialize()

    const config = manager.getServer('typescript')?.config
    assert.equal(config?.command, binary)
    assert.deepEqual(config?.args, ['--stdio'])
    assert.equal(processCalls, 0)
  })

  test('preserves an explicit project LSP server configuration', async () => {
    const root = project()
    setProject(root)
    const custom = join(root, 'custom-lsp-server')
    mkdirSync(join(root, '.babel'), { recursive: true })
    writeFileSync(join(root, '.babel', 'lsp-servers.json'), JSON.stringify({
      typescript: {
        languageId: 'typescript', command: custom, args: ['--stdio'], fileExtensions: ['.ts'],
      },
    }))

    const manager = createLspServerManager()
    await manager.initialize()

    assert.equal(manager.getServer('typescript')?.config.command, custom)
    assert.deepEqual(manager.getServer('typescript')?.config.args, ['--stdio'])
  })
})
