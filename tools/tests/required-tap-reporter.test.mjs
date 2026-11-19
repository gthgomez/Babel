// License: Apache-2.0 — see LICENSE
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function runReporter(root, output, files, testFiles) {
  const reporter = new URL('../../babel-cli/scripts/required_tap_reporter.mjs', import.meta.url).href
  const childEnv = {...process.env, BABEL_TAP_EXECUTION_PATH:join(output,'execution.json')}
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.NODE_TEST_WORKER_ID
  const tsx = fileURLToPath(new URL('../../babel-cli/node_modules/tsx/dist/cli.mjs', import.meta.url))
  const sha256 = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
  writeFileSync(join(output, 'selection.json'), JSON.stringify({ schemaVersion:1, suite:'unit',
    platform:process.platform, arch:process.arch, nodeVersion:process.version,
    packageScriptSha256:'a'.repeat(64), files:files.map(path => ({path, sha256:sha256(path)})) }))
  return spawnSync(process.execPath, [tsx, '--test', '--test-reporter='+reporter, ...testFiles.map(path => join(root, path))], {
    cwd:root, encoding:'utf8', timeout:30000, env:childEnv,
  })
}

test('distinct test files with identical suite and case titles keep distinct TAP identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-reporter-identity-'))
  const output = join(root, 'artifacts')
  const files = ['src/alphaAcp.test.ts', 'src/betaAcp.test.ts']
  try {
    mkdirSync(output)
    for (const path of files) {
      mkdirSync(dirname(join(root, path)), {recursive:true})
      writeFileSync(join(root, path), [
        "import {describe,it} from 'node:test'",
        "describe('sharedRuntime', () => {",
        "  it('replays the same case title', () => {})",
        "})",
      ].join('\n'))
    }
    const run = runReporter(root, output, files, files)
    assert.equal(run.status, 0, run.stderr)
    writeFileSync(join(output,'full.tap'), run.stdout)
    const summary = fileURLToPath(new URL('../../babel-cli/scripts/summarize_required_tap.mjs', import.meta.url))
    const result = spawnSync(process.execPath,[summary,'unit',output],{encoding:'utf8',timeout:30000})
    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(join(output,'results.json'),'utf8'))
    assert.equal(evidence.status, 'complete')
    assert.equal(evidence.errors.includes('duplicate_test_id'), false)
    assert.equal(evidence.testCount, 2)
    assert.deepEqual(evidence.tests.map(test => test.id).sort(), [
      'src/alphaAcp.test.ts :: sharedRuntime / replays the same case title',
      'src/betaAcp.test.ts :: sharedRuntime / replays the same case title',
    ])
    assert.deepEqual(evidence.tests.map(test => test.sourceFile).sort(), files)
  } finally { rmSync(root,{recursive:true, force:true}) }
})

test('actual Node reporter binds skipped leaf source and reason to the required TAP summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-reporter-fixture-'))
  const output = join(root, 'artifacts')
  const skip = process.platform === 'win32' ? {
    path: 'src/runners/providerEngine.test.ts', name: 'ProviderEngine uses native standalone Go with shared budget and stable job session',
    reason: 'POSIX directory fsync is required; durable Go reservations explicitly unsupported on Windows',
  } : {
    path: 'src/ui/terminalProbe.test.ts', name: 'Windows Terminal defaults dec2026Sync to false', reason: 'Windows-specific fixture',
  }
  try {
    const source = `import test from 'node:test'; test('executed fixture', () => {}); test(${JSON.stringify(skip.name)}, {skip:${JSON.stringify(skip.reason)}}, () => {throw Error('skipped body executed')});`
    const path = join(root, skip.path)
    mkdirSync(dirname(path), {recursive:true}); mkdirSync(output)
    writeFileSync(path, source)
    const sha256 = createHash('sha256').update(source).digest('hex')
    writeFileSync(join(output, 'selection.json'), JSON.stringify({ schemaVersion:1, suite:'unit',
      platform:process.platform, arch:process.arch, nodeVersion:process.version,
      packageScriptSha256:'a'.repeat(64), files:[{path:skip.path,sha256}] }))
    const reporter = new URL('../../babel-cli/scripts/required_tap_reporter.mjs', import.meta.url).href
    const childEnv = {...process.env, BABEL_TAP_EXECUTION_PATH:join(output,'execution.json')}
    delete childEnv.NODE_TEST_CONTEXT
    delete childEnv.NODE_TEST_WORKER_ID
    const tsx = fileURLToPath(new URL('../../babel-cli/node_modules/tsx/dist/cli.mjs', import.meta.url))
    const run = spawnSync(process.execPath, [tsx, '--test', '--test-reporter='+reporter, path], {
      cwd:root, encoding:'utf8', timeout:30000, env:childEnv,
    })
    assert.equal(run.status, 0, run.stderr)
    writeFileSync(join(output,'full.tap'),run.stdout)
    const execution = JSON.parse(readFileSync(join(output,'execution.json'),'utf8'))
    assert.deepEqual(execution.skips,[{...skip,sha256}])
    const summary = fileURLToPath(new URL('../../babel-cli/scripts/summarize_required_tap.mjs', import.meta.url))
    const result = spawnSync(process.execPath,[summary,'unit',output],{encoding:'utf8',timeout:30000})
    assert.equal(result.status,0,result.stderr)
    const evidence = JSON.parse(readFileSync(join(output,'results.json'),'utf8'))
    assert.equal(evidence.passed,1); assert.equal(evidence.skipped,1)
    assert.equal(evidence.reviewedSkips.length,1)
  } finally { rmSync(root,{recursive:true,force:true}) }
})
