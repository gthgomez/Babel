import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pinProjectRootEnv } from './chatEngineSupport.js'
import { governedStrReplace } from './governedMutations.js'
import { createToolExecutor } from './toolExecutor.js'
import { loadEffectLedger } from '../executor/effectLedger.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('interleaved governed roots preserve targets and evidence and restore ambient root out of order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-root-interleave-'))
  const previous = process.env['BABEL_PROJECT_ROOT']
  process.env['BABEL_PROJECT_ROOT'] = root
  const entered = [barrier(), barrier()]
  const releases = [barrier(), barrier()]
  const roots = ['a', 'b'].map(name => join(root, name))
  for (const project of roots) { mkdirSync(project); writeFileSync(join(project, 'file.txt'), 'before') }
  const mutate = async (index: number) => {
    const project = roots[index]!
      return await governedStrReplace({ file_path: 'file.txt', old_str: 'before', new_str: `after-${index}` }, {
        projectRoot: project,
        context: { agentId: 'test', runId: `run-${index}`, runDir: join(project, 'evidence'), babelRoot: project, projectRoot: project },
        executor: createToolExecutor({ executeTool: async (request, context) => {
          entered[index]!.release()
          await releases[index]!.promise
          if (request.tool !== 'file_write') throw new Error('unexpected fixture tool')
          assert.equal(context.projectRoot, project)
          writeFileSync(resolve(context.projectRoot!, request.path), request.content)
          return { exit_code: 0, stdout: '', stderr: '' }
        } }),
      })
  }
  let a: ReturnType<typeof mutate> | undefined
  let b: ReturnType<typeof mutate> | undefined
  try {
    a = mutate(0); await entered[0]!.promise
    b = mutate(1); await entered[1]!.promise
    releases[0]!.release(); assert.equal((await a).exit_code, 0)
    const whileBPending = process.env['BABEL_PROJECT_ROOT']
    releases[1]!.release(); assert.equal((await b).exit_code, 0)
    for (const [index, project] of roots.entries()) {
      assert.equal(readFileSync(join(project, 'file.txt'), 'utf8'), `after-${index}`)
      const record = loadEffectLedger(join(project, 'evidence')).find(row => row.status === 'completed')
      assert.deepEqual(record?.targetPaths, [join(project, 'file.txt')])
    }
    assert.equal(whileBPending, roots[1], 'active compatibility pin must survive out-of-order completion')
    assert.equal(process.env['BABEL_PROJECT_ROOT'], root, 'all pins released must restore original ambient state')
  } finally {
    for (const release of releases) release.release()
    await Promise.allSettled([a, b])
    if (previous === undefined) delete process.env['BABEL_PROJECT_ROOT']; else process.env['BABEL_PROJECT_ROOT'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('support compatibility pins release out of order and idempotently', () => {
  const previous = process.env['BABEL_PROJECT_ROOT']
  const a = pinProjectRootEnv('a')
  const b = pinProjectRootEnv('b')
  a(); assert.equal(process.env['BABEL_PROJECT_ROOT'], 'b')
  a(); b(); assert.equal(process.env['BABEL_PROJECT_ROOT'], previous)
})
