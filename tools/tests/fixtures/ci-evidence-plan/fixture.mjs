// Sanitized offline fixtures; hashes identify synthetic inputs, not real builds.
import { createHash } from 'node:crypto'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const digest = value => sha256(JSON.stringify(value))
export const pin = context => {
  const bytes = JSON.stringify(context)
  return { bytes, expectedSha256: sha256(bytes) }
}

export function fixture() {
  const candidate = { repository: 'example/babel-fixture', headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) }
  const producer = { repository: candidate.repository, event: 'pull_request', workflow: 'Public Release Gate', appId: 15368 }
  const identity = {
    headSha: candidate.headSha, treeSha: candidate.treeSha,
    workflowSha: 'c'.repeat(40), policySha: 'd'.repeat(40),
    commandDigest: sha256('unit command'), lockDigest: sha256('lock'),
    environmentDigest: sha256('Windows; Node22; npm10; isolated fixture'),
    selectionDigest: digest(['src/agent/delivery.test.ts']),
    compiledDigest: sha256('compiled fixture'), packageDigest: sha256('package fixture'),
  }
  const jobs = [
    { name: 'unit-windows', kind: 'unit', identity, selectedPaths: ['src/agent/delivery.test.ts'] },
    { name: 'consumer-windows', kind: 'package', identity: { ...identity, commandDigest: sha256('consumer command') } },
  ]
  const evidence = {
    schemaVersion: 1, candidate, baseline: { headSha: candidate.headSha, treeSha: candidate.treeSha },
    change: { kind: 'unchanged', files: [], dynamicDependencies: 'unchanged', compiledOutput: 'unchanged', packageOutput: 'unchanged', skips: 'unchanged' },
    jobs: jobs.map((job, i) => ({
      name: job.name, identity: structuredClone(job.identity),
      source: { ...producer, runId: '100', jobId: String(200 + i), attempt: 2 },
      attemptStartedAt: '2026-01-02T12:00:00Z',
      startedAt: '2026-01-02T11:00:00Z', completedAt: '2026-01-02T11:02:00Z',
      status: 'completed', conclusion: 'success',
    })),
  }
  evidence.jobs[1].startedAt = '2026-01-02T12:00:05Z'
  evidence.jobs[1].completedAt = '2026-01-02T12:05:05Z'
  evidence.jobs[1].conclusion = 'failure'
  evidence.jobs[1].failure = { phase: 'artifact-upload', log: 'Failed to CreateArtifact: Request timeout' }
  const context = { schemaVersion: 1, candidate: structuredClone(candidate), baseline: structuredClone(evidence.baseline), producer, jobs, evidenceDigest: digest(evidence) }
  return { evidence, context }
}

/** Three real public records; absent input hashes deliberately remain absent. */
export function historicalRetryFixture() {
  const { evidence, context } = fixture()
  const candidate = { repository: 'gthgomez/Babel', headSha: '9f02e06eaa1a1c41de62018da961853286daa6fb', treeSha: '1450134d90acbd291cb0b8faa1e322db351ef42c' }
  evidence.candidate = candidate; context.candidate = structuredClone(candidate)
  evidence.baseline = { headSha: candidate.headSha, treeSha: candidate.treeSha }; context.baseline = structuredClone(evidence.baseline)
  context.producer.repository = candidate.repository
  const records = [
    ['policy-integrity (ubuntu-latest)', '122461466929', '2026-10-27T20:26:45Z', '2026-10-27T20:26:58Z'],
    ['consumer-artifact (windows-latest, Node 24)', '122461470829', '2026-10-27T20:49:14Z', '2026-10-27T20:58:44Z'],
    ['linux-validation', '122466343745', '2026-10-27T20:58:46Z', '2026-10-27T20:58:55Z'],
  ]
  context.jobs = records.map(([name]) => ({ name, kind: 'other', identity: { headSha: candidate.headSha, treeSha: candidate.treeSha } }))
  evidence.jobs = records.map(([name, jobId, startedAt, completedAt]) => ({
    name, identity: { headSha: candidate.headSha, treeSha: candidate.treeSha },
    source: { ...context.producer, runId: '40578100339', jobId, attempt: 2 },
    attemptStartedAt: '2026-10-27T20:49:09Z', startedAt, completedAt, status: 'completed', conclusion: 'success',
  }))
  context.evidenceDigest = digest(evidence)
  return { evidence, context }
}

export function portabilityFixture() {
  const { evidence, context } = fixture()
  evidence.change = {
    ...evidence.change, kind: 'native-path-portability',
    files: [{ path: 'src/agent/delivery.test.ts',
      before: "import { resolve } from 'node:path'\nassert.deepEqual(delivered(input()), ['src/feedback.ts'])\n",
      after: "import { join, resolve } from 'node:path'\nassert.deepEqual(delivered(input()), [join('src', 'feedback.ts')])\n" }],
  }
  context.baseline = { headSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) }
  evidence.baseline = structuredClone(context.baseline)
  context.controls = ['wrong-path-delivery', 'missing-glob-metadata'].map(id => ({
    id, assertionCode: `CONTROL_${id.replaceAll('-', '_').toUpperCase()}`,
    testDigest: sha256(`frozen ${id} test`), mutationDigest: sha256(`seeded ${id} mutation`),
    environmentDigest: context.jobs[0].identity.environmentDigest,
  }))
  evidence.controls = context.controls.map(control => ({
    ...control, headSha: evidence.candidate.headSha, treeSha: evidence.candidate.treeSha,
    goodExitCode: 0, mutantExitCode: 1, mutantOutcome: 'assertion-failure',
  }))
  for (const job of evidence.jobs) { job.status = 'not_run'; job.conclusion = null; job.startedAt = null; job.completedAt = null }
  context.evidenceDigest = digest(evidence)
  return { evidence, context }
}
