import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertReleaseBuildInfo, captureRecordedBuildInputs, createBuildInfo, writeBuildInfo } from './write_build_info.mjs'

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

test('build metadata distinguishes clean, dirty, and unknown source without embedding paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-build-info-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    const unknown = createBuildInfo(root)
    assert.equal(unknown.sourceCommit, null)
    assert.equal(unknown.workingTreeClean, null)
    assert.equal(unknown.buildInputsDigest, null)
    assert.equal(unknown.recordedBuildInputs, null)
    git(root, 'init', '-q')
    writeFileSync(join(root, '.gitignore'), 'dist/\nnode_modules/\n')
    mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '5.8.3' }))
    mkdirSync(join(root, 'node_modules', 'typescript', 'bin'))
    mkdirSync(join(root, 'node_modules', 'typescript', 'lib'))
    writeFileSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '')
    writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '')
    const compiler = join(root, 'node_modules', 'typescript', 'lib', '_tsc.js')
    writeFileSync(compiler, 'fixture compiler bytes')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'source.js'), 'export const value = 1\n')
    git(root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'source.js')
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    const clean = createBuildInfo(root)
    assert.match(clean.sourceCommit, /^[a-f0-9]{40,64}$/)
    assert.equal(clean.workingTreeClean, true)
    assert.equal(clean.packageVersion, '1.2.3')
    assert.equal(clean.typescriptVersion, '5.8.3')
    assert.equal(clean.buildInputsDigest, null)
    assert.equal(clean.recordedBuildInputs.scope, 'cli-manifest-lock-config-and-tsc-files:v1')
    assert.match(clean.recordedBuildInputs.sha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(clean).includes(root), false)
    const expected = { packageVersion: clean.packageVersion, sourceCommit: clean.sourceCommit,
      sourceTree: clean.sourceTree, recordedBuildInputs: captureRecordedBuildInputs(root) }
    assert.doesNotThrow(() => assertReleaseBuildInfo(clean, expected))
    assert.throws(() => assertReleaseBuildInfo({ ...clean, workingTreeClean: false }, expected))
    assert.throws(() => assertReleaseBuildInfo({ ...clean, sourceCommit: 'f'.repeat(40) }, expected))
    assert.throws(() => assertReleaseBuildInfo({ ...clean, typescriptVersion: null }, expected))
    assert.throws(() => assertReleaseBuildInfo({ ...clean, recordedBuildInputs: null }, expected), /CLI build inputs/)
    assert.throws(() => assertReleaseBuildInfo(null, expected))
    const oldGitDir = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = join(root, 'not-the-repository')
      assert.deepEqual(createBuildInfo(root), clean)
    } finally {
      if (oldGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = oldGitDir
    }
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
    writeBuildInfo(root)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist', 'cli', 'build-info.json'), 'utf8')), clean)
    writeFileSync(compiler, 'replaced compiler bytes with the same version')
    const compilerChanged = createBuildInfo(root)
    assert.equal(compilerChanged.workingTreeClean, true)
    assert.notEqual(compilerChanged.recordedBuildInputs.sha256, clean.recordedBuildInputs.sha256)
    assert.equal(compilerChanged.recordedBuildInputs.packageLockSha256, clean.recordedBuildInputs.packageLockSha256)
    assert.throws(() => assertReleaseBuildInfo(compilerChanged, expected), /CLI build inputs/)
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}')
    assert.notEqual(captureRecordedBuildInputs(root).packageLockSha256, clean.recordedBuildInputs.packageLockSha256)
    rmSync(compiler)
    assert.equal(captureRecordedBuildInputs(root), null)
    writeFileSync(join(root, 'source.js'), 'export const value = 2\n')
    const dirty = createBuildInfo(root)
    assert.equal(dirty.workingTreeClean, false)
    assert.equal(dirty.sourceCommit, clean.sourceCommit)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
