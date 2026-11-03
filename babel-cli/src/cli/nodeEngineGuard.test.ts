import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { supportsInstalledNode } from '../installedDoctor.js'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = resolve(cliRoot, 'bin/check-node-engine.mjs')
const versions = ['20.19.0', '22.18.0', '22.19.0', '22.23.3', '23.11.0', '24.0.0', '24.13.0', '24.13.1', '24.14.0', '25.0.0', '26.0.0']

function probeEngineModule(): { supported: Record<string, boolean>; message: string } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { nodeEngineSupported, formatNodeEngineError } from ${JSON.stringify(pathToFileURL(script).href)};
    const versions = ${JSON.stringify(versions)};
    const supported = Object.fromEntries(versions.map((version) => [version, nodeEngineSupported(version)]));
    const message = formatNodeEngineError('20.19.2', 'install');
    process.stdout.write(JSON.stringify({ supported, message }));
  `], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as ReturnType<typeof probeEngineModule>
}

test('install check accepts the same Node versions as the installed doctor', () => {
  const probed = probeEngineModule()
  for (const version of versions) assert.equal(probed.supported[version], supportsInstalledNode(version), version)
  assert.equal(probed.supported['20.19.0'], false)
  assert.equal(probed.supported['22.19.0'], true)
  assert.match(probed.message, /node --version/)
  assert.match(probed.message, /v20\.19\.2/)
  assert.match(probed.message, /babel-harness/)
  assert.match(probed.message, /22\.19\.0/)
  assert.match(probed.message, /https:\/\/nodejs\.org\/en\/download/)
  assert.match(probed.message, /npm stopped installing babel-harness/)
})

test('preinstall check is silent on a supported Node and does not print secrets', () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], OPENROUTER_API_KEY: 'sentinel-do-not-print' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(`${result.stdout}${result.stderr}`.includes('sentinel-do-not-print'), false)
})

test('ExperimentalWarning can be hidden in-process without hiding DeprecationWarning', () => {
  const source = `
    import { suppressExperimentalWarnings } from ${JSON.stringify(pathToFileURL(script).href)};
    if (process.env.APPLY === '1') suppressExperimentalWarnings();
    process.emitWarning('sqlite noise', 'ExperimentalWarning');
    process.emitWarning('dep noise', 'DeprecationWarning');
  `
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { PATH: process.env['PATH'], APPLY: '0' } })
  const hidden = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { PATH: process.env['PATH'], APPLY: '1' } })
  const shown = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { PATH: process.env['PATH'], APPLY: '1', BABEL_SHOW_NODE_WARNINGS: '1' } })
  assert.match(plain.stderr, /ExperimentalWarning/)
  assert.match(plain.stderr, /DeprecationWarning/)
  assert.doesNotMatch(hidden.stderr, /ExperimentalWarning/)
  assert.match(hidden.stderr, /DeprecationWarning/)
  assert.match(shown.stderr, /ExperimentalWarning/)
  assert.match(shown.stderr, /DeprecationWarning/)
})

test('the executable entry suppresses ExperimentalWarning when the build exists', () => {
  const entry = resolve(cliRoot, 'bin/babel.js')
  const dispatch = resolve(cliRoot, 'dist/cliEntryDispatch.js')
  if (!existsSync(dispatch)) return
  const home = mkdtempSync(resolve(tmpdir(), 'babel-node-engine-'))
  const env = { PATH: process.env['PATH'], HOME: home, USERPROFILE: home, BABEL_CONFIG_DIR: home, CI: '1' }
  const result = spawnSync(process.execPath, [entry, 'setup'], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/)
  assert.match(result.stderr, /your-key-here/)
  const shown = spawnSync(process.execPath, [entry, 'setup'], { encoding: 'utf8', env: { ...env, BABEL_SHOW_NODE_WARNINGS: '1' } })
  assert.match(shown.stderr, /ExperimentalWarning/)
})
