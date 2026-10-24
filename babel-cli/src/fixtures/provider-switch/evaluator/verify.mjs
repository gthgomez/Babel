// Invoked by the trusted runner, from any cwd. Candidate code runs only in children.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const evaluatorDir = dirname(self)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const inside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const checks = []
const record = (id, pass) => checks.push({ id, pass: pass === true })
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const env = process.env
try {
  if (process.argv.includes('--plan')) {
    process.stdout.write(JSON.stringify({ schemaVersion: 2, authoritative: false, pass: false, mode: 'plan' }) + '\n')
    process.exit(0)
  }
  for (const key of ['EVALUATOR_SHA256', 'ORACLE_SHA256', 'PRISTINE_LEDGER_SHA256']) {
    if (!validHash(env[key])) throw new Error('Missing or invalid ' + key)
  }
  if (!env.RUN_NONCE || !/^[a-f0-9]{64}$/.test(env.RUN_NONCE)) throw new Error('Missing run binding')
  if (!env.CANDIDATE_WORKSPACE || !isAbsolute(env.CANDIDATE_WORKSPACE)) throw new Error('Absolute candidate workspace required')
  const workspace = realpathSync(env.CANDIDATE_WORKSPACE)
  if (!env.VERDICT_PATH || !isAbsolute(env.VERDICT_PATH)) throw new Error('External absolute VERDICT_PATH required')
  const destinationParent = realpathSync(dirname(env.VERDICT_PATH))
  if (inside(workspace, destinationParent) || inside(realpathSync(join(evaluatorDir, '..')), destinationParent)) {
    throw new Error('Verdict destination is protected')
  }
  if (existsSync(env.VERDICT_PATH)) throw new Error('Verdict destination must be fresh')
  const ledger = join(workspace, 'current', 'ledger.mjs')
  const oracle = join(evaluatorDir, 'probe.mjs')
  record('evaluator_unmodified', hash(self) === env.EVALUATOR_SHA256)
  record('oracle_unmodified', hash(oracle) === env.ORACLE_SHA256)
  const ledgerSha256 = hash(ledger)
  record('ledger_edited', ledgerSha256 !== env.PRISTINE_LEDGER_SHA256)
  if (!checks.every((check) => check.pass)) throw new Error('Frozen integrity check failed')
  // Minimal environment: never pass ambient provider credentials to fixture code.
  const childEnv = { PATH: env.PATH, SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP }
  const run = (args, input) => spawnSync(process.execPath, args, {
    cwd: join(workspace, 'current'), encoding: 'utf8', timeout: 3000,
    maxBuffer: 64 * 1024, windowsHide: true, env: childEnv, input,
  })
  const project = run(['--test'])
  record('project_tests_pass', !project.error && project.status === 0 && !project.signal)
  const cases = [[], [{ id: 'credit', label: 'Keep label', amount: 19, metadata: { category: 'income' } },
    { id: 'debit', amount: -7 }, { amount: 0 }, { amount: 3 }],
    [{ amount: -8 }, { amount: -5 }], [{ amount: 0 }, { amount: 0 }], [{ amount: 2.5 }, { amount: -0.5 }]]
  const expected = [150, 0, 0, 15, 15, -13, -13, 0, 0, 2, 2, 150]
  const probe = run([oracle, ledger], JSON.stringify({ nonce: env.RUN_NONCE, cases }))
  let result
  try { result = JSON.parse(probe.stdout) } catch { /* malformed/absent output fails closed */ }
  record('candidate_protocol', !probe.error && probe.status === 0 && !probe.signal && result?.nonce === env.RUN_NONCE)
  record('independent_cases', JSON.stringify(result?.results) === JSON.stringify(expected) &&
    Array.isArray(result?.preserved) && result.preserved.length === cases.length && result.preserved.every(value => value === true))
  record('ledger_stable_during_verification', hash(ledger) === ledgerSha256)
  record('evaluator_unmodified_after', hash(self) === env.EVALUATOR_SHA256 && hash(oracle) === env.ORACLE_SHA256)
  const verdict = {
    // Only the external runner can qualify this result against trusted baselines.
    schemaVersion: 2, authoritative: false, pass: checks.every((check) => check.pass),
    nonce: env.RUN_NONCE, workspace, ledgerSha256,
    evaluatorSha256: hash(self), oracleSha256: hash(oracle), checks,
  }
  writeFileSync(env.VERDICT_PATH, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify(verdict) + '\n')
  process.exitCode = verdict.pass ? 0 : 1
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
