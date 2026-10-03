import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildIsolatedDockerArgs, hashTree } from '../runner.mjs'

const root = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))

test('fixture digest survives checkout permissions and CRLF conversion', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-fixture-portability-'))
  try {
    const left = path.join(parent, 'left'), right = path.join(parent, 'right')
    await mkdir(left); await mkdir(right)
    await writeFile(path.join(left, 'input.csv'), 'header\nvalue\n')
    await writeFile(path.join(right, 'input.csv'), 'header\r\nvalue\r\n')
    await chmod(path.join(left, 'input.csv'), 0o600)
    await chmod(path.join(right, 'input.csv'), 0o644)
    assert.equal(await hashTree(left), await hashTree(right))
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('zero-GPU isolation omits the Docker GPU request', () => {
  const task = manifest.tasks[0]
  const args = buildIsolatedDockerArgs(task, { role: 'solver', workspace: '/tmp/solver', command: ['node', 'src/summarize.mjs'] })
  assert.ok(!args.some(arg => arg.startsWith('--gpus')))
})

test('CSV grading cannot run a submission or accept a rewritten oracle input', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-csv-oracle-'))
  const workspace = path.join(parent, 'solver')
  try {
    await cp(path.join(root, 'fixtures/csv-rollup-cli/solver'), workspace, { recursive: true })
    await mkdir(path.join(workspace, 'src')); await mkdir(path.join(workspace, 'output'))
    await writeFile(path.join(workspace, 'src/summarize.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('executed.txt','bad');writeFileSync(process.argv[2],'event_id,occurred_at,status,detail\\n');writeFileSync(process.argv[3],'date,status,count\\n');")
    await writeFile(path.join(workspace, 'output/summary.csv'), 'date,status,count\n')
    const grader = await import(pathToFileURL(path.join(root, 'fixtures/csv-rollup-cli/grader/verify.mjs')).href)
    const result = await grader.verify(workspace)
    assert.equal(result.status, 'failed')
    await assert.rejects(readFile(path.join(workspace, 'executed.txt')))
    await writeFile(path.join(workspace, 'input/events.csv'), 'event_id,occurred_at,status,detail\n')
    assert.equal((await grader.verify(workspace)).status, 'failed')
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('repository grading cannot import modified submission source', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-repo-oracle-'))
  const workspace = path.join(parent, 'solver')
  try {
    await cp(path.join(root, 'fixtures/repo-map-read-only/solver'), workspace, { recursive: true })
    const grader = await import(pathToFileURL(path.join(root, 'fixtures/repo-map-read-only/grader/verify.mjs')).href)
    await grader.writeReference(workspace)
    await writeFile(path.join(workspace, 'src/api/charge-route.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync(new URL('../../executed.txt',import.meta.url),'bad');export function postCharge(){return {status:403,code:'TENANT_MISMATCH'}}")
    assert.equal((await grader.verify(workspace)).status, 'failed')
    await assert.rejects(readFile(path.join(workspace, 'executed.txt')))
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('actual grader runner uses trusted fixture policy and never executes submitted code', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-grader-policy-'))
  const workspace = path.join(parent, 'solver')
  try {
    await cp(path.join(root, 'fixtures/csv-rollup-cli/solver'), workspace, { recursive: true })
    const verifierPath = path.join(root, 'fixtures/csv-rollup-cli/grader/verify.mjs')
    const grader = await import(pathToFileURL(verifierPath).href)
    await grader.writeReference(workspace)
    const reference = spawnSync(process.execPath, [path.join(workspace, 'src/summarize.mjs'), 'input/events.csv', 'output/summary.csv'], { cwd: workspace, encoding: 'utf8', timeout: 5000 })
    assert.equal(reference.status, 0, reference.stderr)
    await writeFile(path.join(workspace, 'src/summarize.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('executed.txt','bad');")
    const run = () => spawnSync(process.execPath, [path.join(root, 'grader-runner.mjs'), workspace, verifierPath, 'csv-rollup-cli'], { encoding: 'utf8', timeout: 10000 })
    const validArtifact = run()
    assert.equal(validArtifact.status, 0, validArtifact.stderr)
    assert.equal(JSON.parse(validArtifact.stdout).status, 'passed')
    await assert.rejects(readFile(path.join(workspace, 'executed.txt')))
    await writeFile(path.join(workspace, 'input/events.csv'), 'event_id,occurred_at,status,detail\n')
    const tampered = run()
    assert.equal(tampered.status, 1, tampered.stderr)
    const report = JSON.parse(tampered.stdout)
    assert.equal(report.status, 'failed')
    assert.match(report.errors[0], /Unauthorized changes: input\/events.csv/)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

for (const invalid of ['missing artifact', 'binary candidate']) {
  test(`actual grader records ${invalid} as a task failure`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-invalid-submission-'))
    const workspace = path.join(parent, 'solver')
    try {
      await cp(path.join(root, 'fixtures/csv-rollup-cli/solver'), workspace, { recursive: true })
      const verifierPath = path.join(root, 'fixtures/csv-rollup-cli/grader/verify.mjs')
      const grader = await import(pathToFileURL(verifierPath).href)
      await grader.writeReference(workspace)
      const reference = spawnSync(process.execPath, [path.join(workspace, 'src/summarize.mjs'), 'input/events.csv', 'output/summary.csv'], { cwd: workspace, encoding: 'utf8', timeout: 5000 })
      assert.equal(reference.status, 0, reference.stderr)
      if (invalid === 'missing artifact') await rm(path.join(workspace, 'src/summarize.mjs'))
      else await writeFile(path.join(workspace, 'unexpected.bin'), Buffer.from([0, 255, 1]))
      const result = spawnSync(process.execPath, [path.join(root, 'grader-runner.mjs'), workspace, verifierPath, 'csv-rollup-cli'], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(JSON.parse(result.stdout).status, 'failed')
    } finally { await rm(parent, { recursive: true, force: true }) }
  })
}
