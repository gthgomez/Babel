/** Summarize same-fixture git-metadata phase evidence from a native Chat calibration report directory. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const reportRoot = process.argv[2]
if (!reportRoot) {
  console.error('Usage: node diagnose_calibration_git_metadata.mjs <calibration-out-dir>')
  process.exit(2)
}

const report = JSON.parse(await readFile(join(reportRoot, 'report.json'), 'utf8'))
const tasks = []
for (const row of report.tasks) {
  const phasesPath = join(reportRoot, row.id, 'protected', 'git-metadata-phases.json')
  let phases = null
  try {
    phases = JSON.parse(await readFile(phasesPath, 'utf8'))
  } catch {
    phases = { missing: true }
  }
  tasks.push({
    id: row.id,
    oracleVerdict: row.oracleVerdict,
    outcome: row.outcome,
    diagnostics: row.diagnostics,
    expectedDigest: phases.expectedDigest ?? null,
    phases: phases.phases?.map(phase => ({
      label: phase.label,
      digest: phase.digest,
      driftedPaths: phase.changesFromPrior?.map(change => change.path) ?? [],
    })) ?? null,
  })
}

console.log(JSON.stringify({ mode: report.mode, calibrationPasses: report.summary.calibrationPasses, tasks }, null, 2))
