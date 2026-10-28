import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleGlobTool } from './repoSearch.js'
import { collectTextFiles } from '../services/indexer.js'
import { resetRipgrepDetection } from './ripgrep.js'
import { formatResultDetail } from '../agent/chatEngineSupport.js'
import { formatRegisteredToolObservation } from '../agent/codingLoop/readArtifactExecutor.js'

for (const fallback of [false, true]) {
  test(`glob preserves structured filenames, counts and truncation (${fallback ? 'forced fallback' : 'automatic backend'})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-glob-result-'))
    const previousRoot = process.env.BABEL_PROJECT_ROOT
    const previousPath = process.env.PATH
    process.env.BABEL_PROJECT_ROOT = root
    if (fallback) { process.env.PATH = ''; resetRipgrepDetection() }
    try {
      const action = { type: 'glob', pattern: '*' } as const
      const run = (max_paths?: number) => handleGlobTool({ pattern: '*', ...(max_paths ? { max_paths } : {}) })
      const empty = await run()
      assert.equal(empty.stdout, 'No paths matched.')
      assert.equal(formatResultDetail(action, empty), '0 matches')
      assert.deepEqual(empty.glob_result, { paths: [], returned_count: 0, truncated: false })
      const sentinel = process.platform === 'win32' ? 'No paths matched..txt' : 'No paths matched.'
      writeFileSync(join(root, sentinel), 'synthetic')
      const one = await run()
      assert.equal(one.stdout, sentinel, 'legacy display remains compatible')
      assert.equal(formatResultDetail(action, one), '1 matches')
      assert.deepEqual(one.glob_result, { paths: [sentinel], returned_count: 1, truncated: false })
      for (const name of ['a.ts', '数据.txt', 'Dockerfile', 'LICENSE', 'image.bin', ...(process.platform === 'win32' ? [] : ['line\nbreak.txt'])]) writeFileSync(join(root, name), 'synthetic')
      const all = await run()
      const data = all.glob_result
      assert.ok(data)
      assert.equal(data.returned_count, process.platform === 'win32' ? 6 : 7)
      assert.equal(data.paths.length, data.returned_count)
      assert.ok(data.paths.includes('数据.txt'))
      if (process.platform !== 'win32') assert.ok(data.paths.includes('line\nbreak.txt'))
      assert.equal(formatResultDetail(action, all), `${data.returned_count} matches`)
      const bounded = await run(2)
      assert.equal(bounded.glob_result?.returned_count, 2)
      assert.equal(bounded.glob_result?.truncated, true)
      assert.equal(formatResultDetail(action, bounded), '2 matches (truncated)')
      const json = await handleGlobTool({ pattern: '*', max_paths: 2, output_format: 'json' })
      assert.equal(JSON.parse(json.stdout).truncated, true)
      assert.equal(JSON.parse(json.stdout).matches.length, 2)
      const observation = formatRegisteredToolObservation(action, all, { read: () => '', writeSpill: () => { throw Error('unexpected spill') } }, 'glob-fixture')
      const line = observation.split('\n').find(line => line.startsWith('glob_result: '))
      assert.ok(line, 'actual registered observation must carry structured data to the model')
      assert.deepEqual(JSON.parse(line.slice('glob_result: '.length)), data)
      process.env.BABEL_PROJECT_ROOT = join(root, 'absent')
      const failure = await run()
      assert.equal(failure.exit_code, 1)
      assert.equal(failure.glob_result, undefined, 'errors cannot masquerade as zero matches')
    } finally {
      if (previousRoot === undefined) delete process.env.BABEL_PROJECT_ROOT; else process.env.BABEL_PROJECT_ROOT = previousRoot
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath
      resetRipgrepDetection()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('model glob metadata stays bounded without splitting filenames or hiding omitted paths', () => {
  const paths = Array.from({ length: 100 }, (_, index) => `数据/${index}-${'x'.repeat(180)}.txt`)
  const result = { exit_code: 0, stderr: '', stdout: paths.join('\n'), glob_result: { paths, returned_count: paths.length, truncated: false } }
  const observation = formatRegisteredToolObservation({ type: 'glob', pattern: '*' }, result,
    { read: () => '', writeSpill: () => { throw Error('unexpected spill') } }, 'bounded-glob')
  const line = observation.split('\n').find(line => line.startsWith('glob_result: '))!
  assert.ok(line.length <= 4013, 'structured metadata must honor the existing prompt budget')
  const data = JSON.parse(line.slice('glob_result: '.length))
  assert.equal(data.returned_count, 100, 'source-returned count stays exact')
  assert.equal(data.truncated, false, 'source truncation differs from prompt omission')
  assert.ok(data.paths.length > 0 && data.paths.length < paths.length)
  assert.equal(data.paths_omitted, paths.length - data.paths.length)
  assert.deepEqual(data.paths, paths.slice(0, data.paths.length), 'complete filenames remain intact')
})


test('fallback glob keeps traversal exclusions and discloses incomplete depth scans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-glob-fallback-boundary-'))
  const oldRoot = process.env.BABEL_PROJECT_ROOT
  const oldPath = process.env.PATH
  process.env.BABEL_PROJECT_ROOT = root
  process.env.PATH = ''
  resetRipgrepDetection()
  try {
    writeFileSync(join(root, 'LICENSE'), 'license fixture')
    writeFileSync(join(root, 'source.ts'), 'source fixture')
    for (const dir of ['.git', 'node_modules']) {
      mkdirSync(join(root, dir))
      writeFileSync(join(root, dir, 'hidden.ts'), 'excluded')
    }
    const indexed = await collectTextFiles(root, [], { projectRoot: root })
    assert.deepEqual(indexed, [join(root, 'source.ts')], 'text indexing does not inherit glob enumeration semantics')
    const complete = await handleGlobTool({ pattern: '**/*' })
    assert.deepEqual(complete.glob_result, { paths: ['LICENSE', 'source.ts'], returned_count: 2, truncated: false })
    const deep = join(root, ...Array.from({ length: 17 }, () => 'nested'))
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'unseen'), 'unseen')
    const partial = await handleGlobTool({ pattern: '**/unseen' })
    assert.deepEqual(partial.glob_result, { paths: [], returned_count: 0, truncated: true })
  } finally {
    if (oldRoot === undefined) delete process.env.BABEL_PROJECT_ROOT; else process.env.BABEL_PROJECT_ROOT = oldRoot
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    resetRipgrepDetection()
    rmSync(root, { recursive: true, force: true })
  }
})
