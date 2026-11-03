import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { supportsInstalledNode } from '../installedDoctor.js'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = resolve(cliRoot, 'bin/check-node-engine.mjs')
const versions = ['20.19.0', '22.18.0', '22.19.0', '22.23.3', '23.11.0', '24.0.0', '24.13.0', '24.13.1', '24.14.0', '25.0.0', '26.0.0']

function probeEngineModule(): {
  supported: Record<string, boolean>
  message: string
  relaunch: { plain: boolean; already: boolean; show: boolean; trace: boolean; deprecationOnly: boolean; nodeOptions: boolean }
} {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { nodeEngineSupported, formatNodeEngineError, shouldRelaunchWithoutExperimentalWarnings } from ${JSON.stringify(pathToFileURL(script).href)};
    const versions = ${JSON.stringify(versions)};
    const supported = Object.fromEntries(versions.map((version) => [version, nodeEngineSupported(version)]));
    const message = formatNodeEngineError('20.19.2', 'install');
    const relaunch = {
      plain: shouldRelaunchWithoutExperimentalWarnings({ execArgv: [], env: {} }),
      already: shouldRelaunchWithoutExperimentalWarnings({ execArgv: ['--disable-warning=ExperimentalWarning'], env: {} }),
      show: shouldRelaunchWithoutExperimentalWarnings({ execArgv: [], env: { BABEL_SHOW_NODE_WARNINGS: '1' } }),
      trace: shouldRelaunchWithoutExperimentalWarnings({ execArgv: ['--trace-warnings'], env: {} }),
      deprecationOnly: shouldRelaunchWithoutExperimentalWarnings({ execArgv: ['--disable-warning=DEP0005'], env: {} }),
      nodeOptions: shouldRelaunchWithoutExperimentalWarnings({ execArgv: [], env: { NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } }),
    };
    process.stdout.write(JSON.stringify({ supported, message, relaunch }));
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
  assert.equal(probed.relaunch.plain, true)
  assert.equal(probed.relaunch.already, false)
  assert.equal(probed.relaunch.show, false)
  assert.equal(probed.relaunch.trace, false)
  assert.equal(probed.relaunch.deprecationOnly, true)
  assert.equal(probed.relaunch.nodeOptions, false)
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

test('ExperimentalWarning can be hidden without hiding DeprecationWarning', () => {
  const source = `
    process.emitWarning('sqlite noise', 'ExperimentalWarning');
    process.emitWarning('dep noise', 'DeprecationWarning');
  `
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  const hidden = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], { encoding: 'utf8' })
  assert.match(plain.stderr, /ExperimentalWarning/)
  assert.match(plain.stderr, /DeprecationWarning/)
  assert.doesNotMatch(hidden.stderr, /ExperimentalWarning/)
  assert.match(hidden.stderr, /DeprecationWarning/)
})

test('the executable entry suppresses ExperimentalWarning when the build exists', () => {
  const entry = resolve(cliRoot, 'bin/babel.js')
  const dispatch = resolve(cliRoot, 'dist/cliEntryDispatch.js')
  if (!existsSync(dispatch)) return
  const result = spawnSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /0\.2\.0/)
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/)
})
