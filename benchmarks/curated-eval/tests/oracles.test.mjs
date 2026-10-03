import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { loadCatalog, prepareTaskWorkspace } from '../runner.mjs'

const root = path.resolve(import.meta.dirname, '..')

function verifyInFreshProcess(graderPath, workspace) {
  const result = spawnSync(process.execPath, [graderPath, workspace], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  })
  const line = result.stdout.trim().split(/\r?\n/).at(-1)
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`Verifier did not return JSON (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
}

test('every original oracle rejects the broken baseline, accepts its reference repair, and rejects a negative control', async () => {
  const catalog = await loadCatalog(root)
  const originals = catalog.tasks.filter((task) => task.source.kind === 'babel_original')

  for (const task of originals) {
    await test(task.id, async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), `babel-curated-${task.id}-`))
      const workspace = path.join(parent, 'solver')
      try {
        await prepareTaskWorkspace(root, task.id, workspace)
        const graderPath = path.join(root, task.fixture.grader_dir, 'verify.mjs')
        const grader = await import(pathToFileURL(graderPath).href)
        const baseline = verifyInFreshProcess(graderPath, workspace)
        assert.equal(baseline.status, 'failed', 'broken or no-op starter must not pass')
        await assert.rejects(readFile(path.join(workspace, 'oracle', 'verify.mjs')))
        await assert.rejects(readFile(path.join(workspace, 'reference', 'solve.mjs')))

        await grader.writeReference(workspace)
        const repaired = verifyInFreshProcess(graderPath, workspace)
        assert.equal(repaired.status, 'passed', repaired.errors.join('\n'))

        const artifact = task.expected_artifacts[0]
        await writeFile(path.join(workspace, artifact), '/* deliberate broken negative control */\n')
        const negative = verifyInFreshProcess(graderPath, workspace)
        assert.equal(negative.status, 'failed', 'oracle must reject a deliberately broken repair')
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })
  }
})
