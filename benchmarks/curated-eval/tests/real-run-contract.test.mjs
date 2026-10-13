import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadCatalog } from '../runner.mjs'
import {
  assessRealRunContract,
  candidateScopedRead,
  candidateScopedWrite,
  ISOLATION_CANARY_FILE,
  LIVE_TRIAL_EXECUTED,
} from '../real-run-contract.mjs'

const root = path.resolve(import.meta.dirname, '..')
const catalog = await loadCatalog(root)
const task = catalog.tasks.find((entry) => entry.id === 'csv-rollup-cli')
const environmentIdentity = `sha256:${'ab'.repeat(32)}`

function attempt(overrides = {}) {
  return {
    terminal_status: 'completed',
    engine_terminal_outcome: 'VERIFIED_COMPLETE',
    completion_claimed: false,
    verifier: { status: 'passed', assertions: 1, errors: [] },
    diff: { added: [], modified: [], deleted: [] },
    scripted_provider: false,
    model_performance_claim: false,
    ...overrides,
  }
}

async function withBundle(adjust, check) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-real-run-'))
  const candidate = path.join(parent, 'candidate')
  const grading = path.join(parent, 'grading')
  const transcriptPath = path.join(parent, 'transcript.log')
  const token = `babel-canary-${randomBytes(16).toString('hex')}`
  try {
    await mkdir(candidate)
    await mkdir(grading)
    await writeFile(path.join(grading, ISOLATION_CANARY_FILE), `${token}\n`)
    await writeFile(transcriptPath, 'turn 1\ncandidate output\n')
    const input = {
      task,
      attempt: attempt(),
      candidate_root: candidate,
      grading_root: grading,
      transcript_path: transcriptPath,
      grading_provenance: 'isolated_harness',
      binding: {
        executable_path: process.execPath,
        model_id: 'deepseek-v4.1-flash',
        environment_identity: environmentIdentity,
      },
    }
    await adjust?.({ parent, candidate, grading, transcriptPath, token, input })
    const result = await assessRealRunContract(input)
    await check(result, { parent, candidate, grading, transcriptPath, token, input })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

function assertUnscored(result) {
  assert.equal(result.live_trial_executed, false)
  assert.equal(result.provider_requests, 0)
  assert.equal(result.model_performance_claim, false)
  assert.equal(result.numeric_score, null)
  assert.notEqual(result.numeric_score, 0)
  assert.equal(result.admitted, false)
  assert.equal(result.real_run_score, null)
  assert.notEqual(result.outcome, 'valid_success')
  assert.equal(result.patch_correct, null)
}

test('the contract module records no live trial', async () => {
  assert.equal(LIVE_TRIAL_EXECUTED, false)
  const source = await readFile(path.join(root, 'real-run-contract.mjs'), 'utf8')
  assert.doesNotMatch(source, /child_process|node:net|node:http|node:https|\bfetch\(/)
})

test('a captured transcript and full binding can admit task evidence without executing a model', async () => {
  await withBundle(null, (result) => {
    assert.equal(result.admitted, true)
    assert.equal(result.outcome, 'valid_success')
    assert.equal(result.real_run_score, 'valid_success')
    assert.equal(result.session_completed, true)
    assert.equal(result.patch_correct, true)
    assert.equal(result.live_trial_executed, false)
    assert.equal(result.model_performance_claim, false)
    assert.equal(result.provider_requests, 0)
    assert.equal(result.numeric_score, null)
    assert.equal(result.transcript_captured, true)
    assert.match(result.transcript_digest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(result.grading_root_inaccessible, true)
    assert.equal(result.grading_inputs_candidate_writable, false)
    assert.equal(result.isolation_canary, 'passed')
    assert.deepEqual(result.reasons, [])
  })
})

test('transcript capture is required before a real-run score is admissible', async () => {
  await withBundle(async ({ input }) => {
    input.transcript_path = null
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.equal(result.transcript_captured, false)
    assert.ok(result.reasons.includes('transcript_missing'))
  })

  await withBundle(async ({ transcriptPath }) => {
    await writeFile(transcriptPath, '')
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.ok(result.reasons.includes('transcript_empty'))
  })

  await withBundle(async ({ candidate, input }) => {
    const inside = path.join(candidate, 'transcript.log')
    await writeFile(inside, 'rewritable transcript\n')
    input.transcript_path = inside
  }, (result) => {
    assertUnscored(result)
    assert.ok(result.reasons.includes('transcript_inside_candidate'))
  })
})

test('a transcript digest mismatch fails the run instead of admitting the score', async () => {
  await withBundle(async ({ input }) => {
    input.transcript_digest = `sha256:${'cd'.repeat(32)}`
  }, async (result, { transcriptPath }) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'integrity_failure')
    assert.ok(result.reasons.includes('transcript_digest_mismatch'))
    const bytes = await readFile(transcriptPath)
    assert.equal(result.transcript_digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  })
})

test('missing executable, model, or environment binding stays unknown', async () => {
  for (const field of ['executable_path', 'model_id', 'environment_identity']) {
    await withBundle(async ({ input }) => {
      delete input.binding[field]
    }, (result) => {
      assertUnscored(result)
      assert.equal(result.outcome, 'unknown')
      assert.ok(result.binding.missing.includes(field), field)
      assert.ok(result.reasons.includes(`binding_missing:${field}`), field)
    })
  }

  await withBundle(async ({ input }) => {
    input.binding.environment_identity = 'host'
    input.binding.model_id = 'unknown'
    input.binding.executable_path = 'node'
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.ok(result.reasons.includes('binding_unbound:environment_identity'))
    assert.ok(result.reasons.includes('binding_unbound:model_id'))
    assert.ok(result.reasons.includes('binding_unbound:executable_path'))
  })
})

test('grading inputs inside the candidate workspace are not an inaccessible grading root', async () => {
  await withBundle(async ({ candidate, input }) => {
    const nested = path.join(candidate, 'grader')
    await mkdir(nested)
    await writeFile(path.join(nested, ISOLATION_CANARY_FILE), `babel-canary-${'e'.repeat(24)}\n`)
    input.grading_root = nested
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'integrity_failure')
    assert.equal(result.grading_root_inaccessible, false)
    assert.equal(result.grading_inputs_candidate_writable, true)
    assert.equal(result.isolation_canary, 'failed')
    assert.ok(result.reasons.includes('grading_root_not_inaccessible'))
  })
})

test('an isolation canary fails the run when the candidate can see or alter the grader', async () => {
  await withBundle(async ({ candidate, grading, token }) => {
    await symlink(path.join(grading, ISOLATION_CANARY_FILE), path.join(candidate, 'grader-link'))
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'integrity_failure')
    assert.equal(result.isolation_canary, 'failed')
    assert.ok(result.reasons.includes('isolation_symlink'))
  })

  await withBundle(async ({ candidate, grading, token }) => {
    await writeFile(path.join(candidate, 'seen.txt'), token)
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'integrity_failure')
    assert.ok(result.reasons.includes('isolation_canary_seen'))
    assert.equal(result.grading_inputs_candidate_writable, false)
  })

  await withBundle(async ({ candidate, grading }) => {
    await link(path.join(grading, ISOLATION_CANARY_FILE), path.join(candidate, 'grader-hardlink'))
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'integrity_failure')
    assert.ok(result.reasons.includes('isolation_hardlink'))
    assert.equal(result.grading_inputs_candidate_writable, true)
  })
})

test('a missing canary does not count as isolation or as a zero score', async () => {
  await withBundle(async ({ grading }) => {
    await rm(path.join(grading, ISOLATION_CANARY_FILE))
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.equal(result.isolation_canary, 'missing')
    assert.equal(result.grading_root_inaccessible, null)
    assert.ok(result.reasons.includes('isolation_canary_missing'))
  })
})

test('self-graded and scripted payloads are refused', async () => {
  await withBundle(async ({ input }) => {
    input.self_graded = true
    input.attempt.verifier = { status: 'passed', assertions: 1, errors: [], source: 'candidate' }
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.ok(result.reasons.includes('self_graded'))
  })

  await withBundle(async ({ candidate, input }) => {
    const gradePath = path.join(candidate, 'grade.json')
    await writeFile(gradePath, '{"status":"passed"}\n')
    input.grade_path = gradePath
  }, (result) => {
    assertUnscored(result)
    assert.ok(result.reasons.includes('self_graded'))
  })

  await withBundle(async ({ input }) => {
    input.attempt.scripted_provider = true
  }, (result) => {
    assertUnscored(result)
    assert.equal(result.outcome, 'unknown')
    assert.ok(result.reasons.includes('scripted_provider'))
  })

  await withBundle(async ({ input }) => {
    input.model_performance_claim = true
  }, (result) => {
    assertUnscored(result)
    assert.ok(result.reasons.includes('model_performance_claim_refused'))
    assert.equal(result.model_performance_claim, false)
  })
})

test('a passing patch cannot turn a blocked or failed engine outcome into success', async () => {
  for (const [status, terminal, outcome] of [
    ['completed', 'BLOCKED_EXTERNAL', 'task_failure'],
    ['blocked', 'BLOCKED_POLICY', 'task_failure'],
    ['failed', 'AGENT_FAILURE', 'task_failure'],
    ['cancelled', 'CANCELLED', 'cancelled'],
    ['limit_reached', 'BUDGET_EXHAUSTED', 'budget_truncated'],
    ['infra_failed', 'INFRA_FAILURE', 'infrastructure_error'],
  ]) {
    await withBundle(async ({ input }) => {
      input.attempt = attempt({
        terminal_status: status,
        engine_terminal_outcome: terminal,
        session_completed: true,
        completion_claimed: true,
      })
    }, (result) => {
      assert.equal(result.admitted, true, terminal)
      assert.equal(result.outcome, outcome, terminal)
      assert.equal(result.real_run_score, outcome, terminal)
      assert.notEqual(result.outcome, 'valid_success', terminal)
      assert.equal(result.session_completed, false, terminal)
      assert.equal(result.patch_correct, true, terminal)
      assert.equal(result.false_complete, true, terminal)
      assert.equal(result.live_trial_executed, false, terminal)
      assert.equal(result.numeric_score, null, terminal)
    })
  }
})

test('an unauthorized change still blocks valid success after the integrity contract passes', async () => {
  await withBundle(async ({ input }) => {
    input.attempt = attempt({ diff: { added: [], modified: ['input/events.csv'], deleted: [] } })
  }, (result) => {
    assert.equal(result.admitted, true)
    assert.equal(result.outcome, 'task_failure')
    assert.equal(result.session_completed, true)
    assert.equal(result.patch_correct, true)
    assert.notEqual(result.real_run_score, 'valid_success')
  })
})

test('candidate path escapes cannot read or write the grading root', async () => {
  await withBundle(null, async (_result, { candidate, grading, token }) => {
    const canary = path.join(grading, ISOLATION_CANARY_FILE)
    const before = await readFile(canary, 'utf8')
    await assert.rejects(candidateScopedRead(candidate, path.relative(candidate, canary)), { code: 'EACCES' })
    await assert.rejects(candidateScopedRead(candidate, canary), { code: 'EACCES' })
    await assert.rejects(candidateScopedWrite(candidate, path.relative(candidate, canary), 'probe'), { code: 'EACCES' })
    assert.equal(await readFile(canary, 'utf8'), before)
    assert.equal(before.includes(token), true)
    const probe = path.join(candidate, 'probe.txt')
    await candidateScopedWrite(candidate, 'probe.txt', 'inside')
    assert.equal(await readFile(probe, 'utf8'), 'inside')
  })
})
