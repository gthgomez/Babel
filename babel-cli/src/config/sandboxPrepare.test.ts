import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RECOMMENDED_SANDBOX_IMAGE, prepareRecommendedSandbox, writeSandboxImageId, type DockerExecute } from './sandboxPrepare.js'

const imageId = `sha256:${'b'.repeat(64)}`

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-sandbox-prepare-'))
  mkdirSync(join(root, 'config'))
  return root
}

test('the recommended image pin matches Babel Desktop', () => {
  const desktop = readFileSync(new URL('../../../babel-desktop/native/sandbox-setup.mjs', import.meta.url), 'utf8')
  assert.match(desktop, new RegExp(RECOMMENDED_SANDBOX_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('a usable sandbox image is left unchanged and docker is not called', () => {
  const root = fixture()
  try {
    const calls: string[][] = []
    const result = prepareRecommendedSandbox({
      env: { BABEL_CONFIG_DIR: join(root, 'config'), BABEL_BENCHMARK_DOCKER_IMAGE: imageId, OPENROUTER_API_KEY: 'sentinel-secret' },
      platform: 'linux',
      execute: (args) => { calls.push(args); return { status: 0, stdout: '' } },
      probe: () => true,
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.pulled, false)
    assert.equal(calls.length, 0)
    assert.equal(result.message.includes('sentinel-secret'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('prepare downloads the pinned image, checks it, and stores only the digest', () => {
  const root = fixture()
  const envFile = join(root, 'config', '.env')
  writeFileSync(envFile, `OPENROUTER_API_KEY=sentinel-secret\nBABEL_BENCHMARK_DOCKER_IMAGE=sha256:${'c'.repeat(64)}\n`, { mode: 0o600 })
  const seen: NodeJS.ProcessEnv[] = []
  const execute: DockerExecute = (args, _timeout, env) => {
    seen.push(env)
    if (args[0] === 'info') return { status: 0, stdout: '24.0.0' }
    if (args[0] === 'pull') {
      assert.equal(args[1], '--platform=linux/amd64')
      assert.equal(args[2], RECOMMENDED_SANDBOX_IMAGE)
      return { status: 0, stdout: '' }
    }
    if (args[0] === 'image') return { status: 0, stdout: JSON.stringify({ Id: imageId, Os: 'linux', Architecture: 'amd64' }) }
    return { status: 1, stdout: '' }
  }
  try {
    const result = prepareRecommendedSandbox({
      env: { BABEL_CONFIG_DIR: join(root, 'config'), OPENROUTER_API_KEY: 'sentinel-secret', PATH: '/usr/bin' },
      platform: 'linux',
      execute,
      probe: (image) => image === imageId,
    })
    assert.equal(result.status, 'prepared')
    assert.equal(result.pulled, true)
    const text = readFileSync(envFile, 'utf8')
    assert.match(text, /OPENROUTER_API_KEY=sentinel-secret/)
    assert.match(text, new RegExp(`BABEL_BENCHMARK_DOCKER_IMAGE=${imageId}`))
    assert.doesNotMatch(text, new RegExp(`sha256:${'c'.repeat(64)}`))
    if (process.platform !== 'win32') assert.equal(statSync(envFile).mode & 0o777, 0o600)
    assert.equal(result.message.includes('sentinel-secret'), false)
    assert.ok(seen.every((env) => env['OPENROUTER_API_KEY'] === undefined))
    assert.equal(seen[0]?.['PATH'], '/usr/bin')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing Docker explains the next step for each platform and does not pull', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const root = fixture()
    try {
      const calls: string[][] = []
      const result = prepareRecommendedSandbox({
        env: { BABEL_CONFIG_DIR: root },
        platform,
        execute: (args) => { calls.push(args); return { status: 1, stdout: '' } },
        probe: () => false,
      })
      assert.equal(result.status, 'fail')
      assert.deepEqual(calls.map((args) => args[0]), ['info'])
      assert.match(result.message, /Docker/)
      if (platform === 'win32') assert.match(result.message, /Docker Desktop for Windows/)
      if (platform === 'darwin') assert.match(result.message, /Docker Desktop for Mac/)
      if (platform === 'linux') assert.match(result.message, /Docker Engine/)
      assert.doesNotMatch(result.message, /Desktop Setup/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('an unverified download is not saved', () => {
  const root = fixture()
  try {
    const result = prepareRecommendedSandbox({
      env: { BABEL_CONFIG_DIR: join(root, 'config') },
      platform: 'linux',
      execute: (args) => {
        if (args[0] === 'info') return { status: 0, stdout: '24.0.0' }
        if (args[0] === 'pull') return { status: 0, stdout: '' }
        if (args[0] === 'image') return { status: 0, stdout: JSON.stringify({ Id: imageId }) }
        return { status: 1, stdout: '' }
      },
      probe: () => false,
    })
    assert.equal(result.status, 'fail')
    assert.equal(result.pulled, true)
    assert.equal(existsSync(join(root, 'config', '.env')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sandbox image writes refuse symlinks and non-digests', () => {
  const root = fixture()
  const file = join(root, 'config', '.env')
  const link = join(root, 'config', 'link.env')
  try {
    writeFileSync(file, 'OPENROUTER_API_KEY=sentinel-secret\n', { mode: 0o600 })
    symlinkSync(file, link)
    assert.throws(() => writeSandboxImageId(link, imageId), /unsafe/)
    assert.equal(readFileSync(file, 'utf8'), 'OPENROUTER_API_KEY=sentinel-secret\n')
    assert.throws(() => writeSandboxImageId(file, 'latest'), /sha256/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
