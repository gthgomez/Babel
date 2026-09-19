#!/usr/bin/env node
/** Run the explicit North Star acceptance inventory without shell globbing. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const required = [
  'src/ui/shell/shellLayout.test.ts',
  'src/ui/shell/shellFrameRenderer.test.ts',
  'src/ui/shell/shellHost.test.ts',
  'src/ui/shell/selectShellHost.test.ts',
  'src/ui/shell/shellInputRouter.test.ts',
  'src/ui/shell/shellNavigation.test.ts',
  'src/ui/shell/shellSources.test.ts',
  'src/ui/shell/shellInspector.test.ts',
  'src/ui/shell/shellOperations.test.ts',
  'src/ui/shell/shellKeyHandler.test.ts',
  'src/ui/shell/shellPanels.test.ts',
  'src/ui/promptInput.test.ts',
  'src/ui/promptInputAdapter.test.ts',
  'src/ui/historyCells/viewport.test.ts',
  'src/ui/historyCells/transcript.test.ts',
  'src/ui/shell/shellRuntimeBinding.test.ts',
  'src/interactive/execution/chatEventDispatch.test.ts',
]

const missing = required.filter((file) => !existsSync(join(packageRoot, file)))
if (missing.length > 0) {
  console.error(`[test:north-star] missing required suites: ${missing.join(', ')}`)
  process.exitCode = 1
} else {
  const manifest = required.join('\n')
  const hash = createHash('sha256').update(manifest).digest('hex')
  console.log(`[test:north-star] discovered ${required.length} required suites (manifest ${hash})`)

  const tsxEntrypoint = join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (!existsSync(tsxEntrypoint)) {
    throw new Error(`tsx entrypoint not found: ${tsxEntrypoint}`)
}
  const child = spawn(
    process.execPath,
    [tsxEntrypoint, '--no-warnings=ExperimentalWarning', '--import', './src/testinfra/register-no-ambient-inference.mjs', '--test', ...required],
    { cwd: packageRoot, env: process.env, stdio: 'inherit', windowsHide: true },
  )
  child.once('error', (error) => {
    console.error(`[test:north-star] child process failed: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1
  })
}
