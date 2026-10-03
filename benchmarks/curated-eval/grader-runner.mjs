import { cp, lstat, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectWorkspaceDiff, loadCatalog, scoreAttempt } from './runner.mjs'

const [solverPath, verifierPath, taskId] = process.argv.slice(2)
if (!solverPath || !verifierPath || !taskId) {
  process.stderr.write('grader runner requires solver path, verifier path, and task id\n')
  process.exit(2)
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'babel-curated-grader-'))
const candidate = path.join(tempRoot, taskId)
class InvalidSubmissionError extends Error {}
try {
  const catalog = await loadCatalog(import.meta.dirname)
  const task = catalog.tasks.find(task => task.id === taskId)
  if (!task || task.source.kind !== 'babel_original') throw new Error('Unknown original task')
  const fixtureRoot = path.join(import.meta.dirname, task.fixture.solver_dir)
  let diff
  try {
    await cp(solverPath, candidate, { recursive: true, dereference: false })
    diff = await collectWorkspaceDiff(fixtureRoot, candidate)
    for (const relative of task.expected_artifacts) {
      const stat = await lstat(path.join(candidate, relative))
      if (!stat.isFile()) throw new Error(`Required artifact is not a regular file: ${relative}`)
    }
  } catch (error) {
    throw new InvalidSubmissionError(`Invalid submission workspace: ${error.message}`)
  }
  const policy = scoreAttempt(task, { terminal_status: 'completed', verifier: { status: 'passed' }, diff })
  if (policy.unauthorized_changes.length) {
    process.stdout.write(`${JSON.stringify({ task_id: taskId, status: 'failed', assertions: 1, errors: [`Unauthorized changes: ${policy.unauthorized_changes.join(', ')}`] })}\n`)
    process.exitCode = 1
  } else {
    const verifier = await import(pathToFileURL(verifierPath).href)
    if (typeof verifier.verify !== 'function') throw new Error('Verifier must export verify(workspace)')
    const result = await verifier.verify(candidate, { fixtureRoot })
    if (!result || !['passed', 'failed', 'infrastructure_error'].includes(result.status) || !Array.isArray(result.errors)) {
      throw new Error('Verifier returned an invalid result')
    }
    process.stdout.write(`${JSON.stringify({ task_id: taskId, ...result })}\n`)
    if (result.status === 'failed') process.exitCode = 1
    if (result.status === 'infrastructure_error') process.exitCode = 2
  }
} catch (error) {
  if (error instanceof InvalidSubmissionError) {
    process.stdout.write(`${JSON.stringify({ task_id: taskId, status: 'failed', assertions: 1, errors: [error.message] })}\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 2
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
