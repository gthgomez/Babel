import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { projectEvaluationEpisode } from './projectEpisode.js'
import { isEvalClaimEligible } from './evaluationEpisode.js'

function writeJsonl(dir: string, name: string, rows: unknown[]): void {
  writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

test('does not double-count tool_started from session and episode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-ep-'))
  writeJsonl(dir, 'session-events.jsonl', [
    { kind: 'tool_started', event_id: 's1', seq: 1 },
    { kind: 'tool_started', event_id: 's2', seq: 2 },
  ])
  writeJsonl(dir, 'episode-events.jsonl', [
    { kind: 'tool_started', event_id: 'e1', seq: 1 },
    { kind: 'tool_started', event_id: 'e2', seq: 2 },
  ])
  const ep = projectEvaluationEpisode({
    runDir: dir,
    task_id: 'C01',
    hidden_ok: true,
    claimed_complete: true,
  })
  assert.equal(ep.trajectory.chronology_authority, 'episode_events')
  assert.equal(ep.trajectory.chronology_disagreement, false)
})

test('session vs episode tool_started mismatch flags disagreement and blocks claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-ep-disagree-'))
  writeJsonl(dir, 'session-events.jsonl', [
    { kind: 'tool_started', event_id: 's1' },
    { kind: 'tool_started', event_id: 's2' },
  ])
  writeJsonl(dir, 'episode-events.jsonl', [{ kind: 'tool_started', event_id: 'e1' }])
  const ep = projectEvaluationEpisode({
    runDir: dir,
    hidden_ok: true,
    claimed_complete: true,
  })
  assert.equal(ep.trajectory.chronology_disagreement, true)
  assert.equal(ep.claim_eligible, false)
})

test('missing episode-events still projects with claim_eligible false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-ep-miss-'))
  writeJsonl(dir, 'session-events.jsonl', [
    { kind: 'tool_started', event_id: 's1', seq: 1 },
    { kind: 'turn_ended', event_id: 's2', seq: 2 },
  ])
  const ep = projectEvaluationEpisode({
    runDir: dir,
    task_id: 'C01',
    hidden_ok: true,
    claimed_complete: true,
  })
  assert.equal(ep.evidence_completeness.episode_events, 'missing')
  assert.equal(ep.diagnosis_confidence, 'partial')
  assert.equal(isEvalClaimEligible(ep), false)
})

test('truncated jsonl is partial not a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-ep-trunc-'))
  writeFileSync(join(dir, 'session-events.jsonl'), '{"kind":"tool_started"}\nNOT_JSON\n')
  const ep = projectEvaluationEpisode({ runDir: dir, hidden_ok: false, claimed_complete: true })
  assert.equal(ep.evidence_completeness.session_events, 'partial')
  assert.equal(ep.outcome.false_complete, true)
  assert.equal(ep.claim_eligible, false)
})
