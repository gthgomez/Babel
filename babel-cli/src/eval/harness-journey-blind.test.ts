import assert from 'node:assert/strict'
import test from 'node:test'
import { createJourneyBlindJob, bindJourneyBlindAssessment } from './harness-journey-blind.js'

test('blind job binds the actual answer and artifact without disclosing route or candidate identity', () => {
  const job = createJourneyBlindJob({ id: 'J07', oracleId: 'j07-v1', requirements: 'Accurate table and supported conclusion.', answer: 'Report saved.', artifact: { text: '<html>6 versus 4</html>', sha256: 'forged' } })
  assert.equal('candidateId' in job, false)
  assert.equal('routeReceipt' in job, false)
  assert.notEqual(job.artifact!.sha256, 'forged')
  const assessment = bindJourneyBlindAssessment(job, { subjectSha256: job.subjectSha256, rubricSha256: job.rubricSha256, rubricId: job.rubricId, relevant: 3, coherent: 2, uncertainty: 3 }, 'protected/independent-grade.json')
  assert.equal(assessment.outputSha256, job.subjectSha256)
  assert.throws(() => bindJourneyBlindAssessment(job, { subjectSha256: '0'.repeat(64), rubricSha256: job.rubricSha256, rubricId: job.rubricId, relevant: 3, coherent: 3, uncertainty: 3 }, 'protected/foreign-grade.json'), /binding/)
})
