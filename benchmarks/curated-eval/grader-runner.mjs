import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [solverPath, verifierPath, taskId] = process.argv.slice(2)
if (!solverPath || !verifierPath || !taskId) {
  process.stderr.write('grader runner requires solver path, verifier path, and task id\n')
  process.exit(2)
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'babel-curated-grader-'))
const candidate = path.join(tempRoot, taskId)
try {
  await cp(solverPath, candidate, { recursive: true, dereference: false })
  const verifier = await import(pathToFileURL(verifierPath).href)
  if (typeof verifier.verify !== 'function') throw new Error('Verifier must export verify(workspace)')
  const result = await verifier.verify(candidate)
  if (!result || !['passed', 'failed', 'infrastructure_error'].includes(result.status) || !Array.isArray(result.errors)) {
    throw new Error('Verifier returned an invalid result')
  }
  process.stdout.write(`${JSON.stringify({ task_id: taskId, ...result })}\n`)
  if (result.status === 'failed') process.exitCode = 1
  if (result.status === 'infrastructure_error') process.exitCode = 2
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 2
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
