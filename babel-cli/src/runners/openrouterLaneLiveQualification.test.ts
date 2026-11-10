import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const liveQualUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'openrouterLaneLiveQualification.mjs'),
).href
const libUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'openrouterLaneQualificationLib.mjs'),
).href

function scratchPaths(prefix: string) {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  return {
    scratch,
    outputPath: join(scratch, 'output.json'),
    redactedRunRecordsPath: join(scratch, 'redacted-run-records.json'),
    runsDir: mkdtempSync(join(tmpdir(), `${prefix}-runs-`)),
  }
}

test('cancellation-only qualification retains output and redacted records without live provider', async () => {
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-e2e-')
  const { createOfflineOpenRouterCancellationFixtureRunner } = await import(libUrl)
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    const report = await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-cancellation-retention-e2e',
      outputPath,
      cancellationOnly: true,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: createOfflineOpenRouterCancellationFixtureRunner,
    })
    assert.equal(report.stopped_billable, false)
    assert.equal(report.provider_errors_observed, 0)
    assert.equal(report.matrix_skipped, true)
    assert.ok(existsSync(outputPath))
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as { results: Array<{ id: string; status: string }> }
    assert.ok(written.results.some((r) => r.id === 'cancellation_stream_abort' && r.status === 'inconclusive'))
    assert.ok(existsSync(redactedRunRecordsPath))
    const records = JSON.parse(readFileSync(redactedRunRecordsPath, 'utf8')) as {
      records: Array<{ id: string; cancellation_probe?: { status: string }; exit_code: null }>
    }
    assert.equal(records.records.length, 1)
    assert.equal(records.records[0]!.id, 'cancellation_stream_abort')
    assert.equal(records.records[0]!.cancellation_probe?.status, 'inconclusive')
    assert.equal(written.results.find((r) => r.id === 'cancellation_stream_abort')?.status, 'inconclusive')
    assert.equal(written.results.find((r) => r.id === 'cancellation_stream_abort')?.status, records.records[0]!.cancellation_probe?.status)
    assert.ok('exit_code' in records.records[0]!)
    assert.equal(report.redacted_run_records_path, redactedRunRecordsPath)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('orchestrator stops on yielded HTTP 402 typed stream error', async () => {
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-402-')
  const { createOfflineOpenRouterHttp402FixtureRunner } = await import(libUrl)
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    const report = await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-cancellation-402-e2e',
      outputPath,
      cancellationOnly: true,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: createOfflineOpenRouterHttp402FixtureRunner,
    })
    assert.equal(report.stopped_billable, true)
    assert.equal(report.verdict, 'provider_stop')
    assert.equal(report.provider_errors_observed, 1)
    assert.equal(report.provider_errors.length, 0)
    const probe = report.results.find((r: { id?: string }) => r.id === 'cancellation_stream_abort')
    assert.ok(probe)
    assert.ok(Array.isArray(probe.provider_stop_matches) && probe.provider_stop_matches.length > 0)
    assert.equal(probe.status, 'provider_stop')
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      results: Array<{ id: string; status: string }>
    }
    const records = JSON.parse(readFileSync(redactedRunRecordsPath, 'utf8')) as {
      records: Array<{ cancellation_probe?: { status: string } }>
    }
    assert.equal(written.results.find((r) => r.id === 'cancellation_stream_abort')?.status, 'provider_stop')
    assert.equal(records.records[0]!.cancellation_probe?.status, 'provider_stop')
    assert.equal(written.results.find((r) => r.id === 'cancellation_stream_abort')?.status, records.records[0]!.cancellation_probe?.status)
    assert.ok(existsSync(outputPath) && existsSync(redactedRunRecordsPath))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('orchestrator stops on exact truncated-stream typed error', async () => {
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-trunc-')
  const { createOfflineOpenRouterTruncatedStreamFixtureRunner } = await import(libUrl)
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    const report = await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-cancellation-trunc-e2e',
      outputPath,
      cancellationOnly: true,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: createOfflineOpenRouterTruncatedStreamFixtureRunner,
    })
    assert.equal(report.stopped_billable, true)
    assert.equal(report.provider_errors_observed, 1)
    const probe = report.results.find((r: { id?: string }) => r.id === 'cancellation_stream_abort')
    assert.match(String(probe?.provider_error_observed), /stream closed before terminal \[DONE\] marker/i)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('orchestrator retains reported usage on cancellation probe record', async () => {
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-usage-')
  const { createOfflineOpenRouterCancellationWithUsageFixtureRunner } = await import(libUrl)
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    const report = await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-cancellation-usage-e2e',
      outputPath,
      cancellationOnly: true,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: createOfflineOpenRouterCancellationWithUsageFixtureRunner,
    })
    const records = JSON.parse(readFileSync(redactedRunRecordsPath, 'utf8')) as {
      records: Array<{ cancellation_probe?: { usage?: { actual_cost_usd: number | null; cost_precision: string } } }>
    }
    assert.equal(records.records[0]!.cancellation_probe?.usage?.actual_cost_usd, 0.004)
    assert.equal(records.records[0]!.cancellation_probe?.usage?.cost_precision, 'reported')
    assert.equal(report.aggregate_known_cost_usd, 0.004)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('redacts synthetic API secrets from nested error_events in all artifacts', async () => {
  const secret = 'sk-or-synthetic-offline-leak-test-647e'
  const prev = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = secret
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-redact-')
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-cancellation-secret-redact-e2e',
      outputPath,
      cancellationOnly: true,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: () => ({
        getLastInvocationMetadata: () => null,
        async *executeWithToolsStream() {
          yield { type: 'error', message: `[openrouter] token=${secret} HTTP 402` }
        },
      }),
    })
    const outputBlob = readFileSync(outputPath, 'utf8')
    const recordsBlob = readFileSync(redactedRunRecordsPath, 'utf8')
    assert.equal(outputBlob.includes(secret), false)
    assert.equal(recordsBlob.includes(secret), false)
    assert.ok(outputBlob.includes('[REDACTED]'))
    assert.ok(recordsBlob.includes('[REDACTED]'))
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prev
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('chat provider stop counts one logical call, not exception duplicate', async () => {
  const { scratch, outputPath, redactedRunRecordsPath, runsDir } = scratchPaths('or647e-live-chat-stop-')
  const { executeOpenRouterLaneLiveQualification } = await import(liveQualUrl)
  try {
    const report = await executeOpenRouterLaneLiveQualification({
      trialLabel: 'offline-chat-stop-dedupe-e2e',
      outputPath,
      cancellationOnly: false,
      runsDir,
      redactedRunRecordsPath,
      createCancellationRunner: () => {
        throw new Error('probe must not run after chat provider stop')
      },
      runChatCliFixture: ({ id }: { id: string }) => {
        if (id === 'readonly_explain') {
          return {
            exitCode: 1,
            stderr: '[openrouter] HTTP 402 Payment Required',
            stdout: '',
            payload: {
              terminal_outcome: 'FAILED',
              status: 'failed',
              usage: { actualCostUSD: 0.001, costComplete: false },
            },
          }
        }
        return null
      },
    })
    assert.equal(report.stopped_billable, true)
    assert.equal(report.provider_errors_observed, 1)
    assert.equal(report.provider_errors.length, 0)
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0]!.id, 'readonly_explain')
    const records = JSON.parse(readFileSync(redactedRunRecordsPath, 'utf8')) as {
      records: Array<{ id: string; usage?: { cost_precision: string } }>
    }
    assert.equal(records.records.length, 1)
    assert.equal(records.records[0]!.id, 'readonly_explain')
    assert.equal(records.records[0]!.usage?.cost_precision, 'unknown')
    assert.ok(existsSync(outputPath))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})
