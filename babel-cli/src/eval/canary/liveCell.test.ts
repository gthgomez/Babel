import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  appendSessionEvent,
  createSessionEventLog,
  rewriteSessionEventLog,
} from '../../agent/sessionEvents.js'
import { sessionCausalAttribution } from './liveCell.js'
import { materializeCanaryWorkspace } from './liveCell.js'
import { getCanaryTask } from './tasks.js'

test('live canary exposes a public authoritative verifier without leaking the oracle', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-live-cell-public-test-'))
  try {
    const spec = getCanaryTask('C01')
    materializeCanaryWorkspace(spec, root)
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: { test?: string }
    }
    assert.equal(packageJson.scripts?.test, 'node public.test.mjs')
    assert.equal(existsSync(join(root, 'public.test.mjs')), true)
    assert.equal(existsSync(join(root, 'hidden.test.mjs')), false)
    assert.notEqual(readFileSync(join(root, 'public.test.mjs'), 'utf8'), spec.oracle_test)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live cell causal attribution persists valid canonical evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-live-cell-causal-'))
  try {
    writeFileSync(join(root, 'thread_events.json'), '{}\n', 'utf8')
    const log = createSessionEventLog('live-cell-causal')
    appendSessionEvent(log, {
      kind: 'model_input_receipt',
      turn_id: 'turn-1',
      inference_id: 'inference-1',
      provider: 'openrouter',
      requested_model_id: 'z-ai/glm-5.3-flash',
      normalized_model_id: 'z-ai/glm-5.3-flash',
      sent_model_id: 'z-ai/glm-5.3-flash',
      input_digest: 'a'.repeat(64),
      input_ref: 'thread_events.json',
    })
    appendSessionEvent(log, {
      kind: 'model_result_delivery',
      turn_id: 'turn-1',
      inference_id: 'inference-1',
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      status: 'delivered',
      observed_model_id: 'z-ai/glm-5.3-flash',
      output_digest: 'b'.repeat(64),
    })
    rewriteSessionEventLog(root, log)

    const report = sessionCausalAttribution(root)
    assert.equal(report.status, 'ok')
    assert.equal(report.event_count, 2)
    assert.equal(report.lifecycle.inference_count, 1)
    assert.equal(report.lifecycle.delivered_result_count, 1)
    assert.equal(report.attribution.family, 'unknown')
    assert.equal(report.attribution.model_blame_permitted, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live cell causal attribution keeps missing evidence UNKNOWN', () => {
  const missing = mkdtempSync(join(tmpdir(), 'babel-live-cell-causal-missing-'))
  try {
    mkdirSync(join(missing, 'does-not-exist'), { recursive: true })
    const report = sessionCausalAttribution(join(missing, 'run'))
    assert.equal(report.status, 'unknown')
    assert.equal(report.attribution.family, 'unknown')
    assert.equal(report.attribution.model_blame_permitted, false)
    assert.match(report.attribution.unknowns.join(' '), /session event log missing/)
  } finally {
    rmSync(missing, { recursive: true, force: true })
  }
})
