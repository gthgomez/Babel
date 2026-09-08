// Append a private operator-recorded quality label. Never affects review or merge gates.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { appendBabelReviewAdjudication } from '../babel-cli/src/services/babelReviewAdjudication.js'
import { assertReviewStateOutsideGit, secretRiskReviewPath } from '../babel-cli/src/services/babelReviewSnapshot.js'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--state-dir' || !args[1] || args[2] !== '--record' || !args[3]) throw new Error('USAGE_STATE_DIR_RECORD_REQUIRED')
const path = resolve(args[3])
if (secretRiskReviewPath(path.replace(/\\/g, '/'))) throw new Error('SECRET_RISK_ADJUDICATION_INPUT')
assertReviewStateOutsideGit(dirname(path))
const info = lstatSync(path)
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024) throw new Error('UNSAFE_ADJUDICATION_INPUT')
try {
  const result = appendBabelReviewAdjudication(args[1], JSON.parse(readFileSync(path, 'utf8')), {
    scan(json) { execFileSync('gitleaks', ['stdin', '--redact', '--no-banner'], { input: json, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 1024 * 1024 }) },
  })
  console.log(JSON.stringify({ status: 'adjudication_recorded', id: result.id, execution_id: result.execution_id, authority: result.authority }))
} catch {
  // A schema/scan diagnostic can contain submitted text; never echo it.
  console.error('ADJUDICATION_REJECTED')
  process.exitCode = 1
}
