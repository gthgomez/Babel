/**
 * Billable OpenRouter Chat qualification matrix for lane 647e.
 * Uses fresh disposable fixtures, independent host oracles, stop-on-provider-error.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync, execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  attachProviderStopToResult,
  buildChatQualificationArtifacts,
  captureRedactedCliRecord,
  collectProbeProviderStopScan,
  countAggregateProviderErrors,
  detectBillableProviderStop,
  gradeMultiFileHostChecks,
  gradeOrdinaryBugHostChecks,
  runStreamCancellationProbe,
} from './openrouterLaneQualificationLib.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {{
 *   trialLabel: string
 *   outputPath: string
 *   mainMergeSha?: string
 *   pre501EvidenceNote?: string
 *   runsDir?: string
 *   cancellationOnly?: boolean
 *   createCancellationRunner?: () => { executeWithToolsStream: Function, getLastInvocationMetadata?: () => unknown }
 *   redactedRunRecordsPath?: string
 *   runChatCliFixture?: (args: { id: string, ws: string, prompt: string, extra: string[] }) => {
 *     exitCode?: number, stderr?: string, stdout?: string, payload?: Record<string, unknown> | null, timedOut?: boolean
 *   } | null | undefined
 * }} options
 */
export async function executeOpenRouterLaneLiveQualification(options) {
  const trialLabel = options.trialLabel
  const outputPath = options.outputPath
  const mainMergeSha = options.mainMergeSha ?? 'ed0c44451a493b70a3a4361cc3236ebb07b453e4'
  const pre501EvidenceNote =
    options.pre501EvidenceNote ??
    'fixtures/openrouter-lane-647e/evidence/pre-501-trial/chat-scenarios-redacted.json (frozen; do not overwrite)'

  const ephemeralRunsRoot =
    options.runsDir ?? mkdtempSync(join(tmpdir(), 'or647e-runs-'))
  mkdirSync(ephemeralRunsRoot, { recursive: true })

  const { runBabelCli, ensureBabelCliDistReady } = await import(
    pathToFileURL(join(packageRoot, 'src/services/liteTrustDemo.ts')).href,
  )
  const distReport = ensureBabelCliDistReady({ mode: 'ensure' })
  const { buildOpenRouterDeepSeekLiveEnv, resolveModelByKey } = await import(
    pathToFileURL(join(packageRoot, 'src/modelPolicy.ts')).href,
  )
  const { OpenRouterApiRunner } = await import(pathToFileURL(join(packageRoot, 'src/runners/openRouterApi.ts')).href)

  const routeKey = 'deepseek-v4.1-flash-openrouter'
  const resolved = resolveModelByKey({ key: routeKey })
  const model = resolved.providerModelId
  const repoRoot = join(packageRoot, '..')

  function redactSecret(text) {
    const key = process.env.OPENROUTER_API_KEY
    if (!key) return text
    return String(text).replaceAll(key, '[REDACTED]')
  }

  function freshWs(fixtureRel) {
    const ws = mkdtempSync(join(tmpdir(), 'or647e-ws-'))
    cpSync(join(packageRoot, 'fixtures/coding-output-acceptance/workspaces', fixtureRel), ws, {
      recursive: true,
    })
    execFileSync('git', ['init'], { cwd: ws, stdio: 'pipe' })
    execFileSync('git', ['add', '-A'], { cwd: ws, stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-m', 'init'], {
      cwd: ws,
      stdio: 'pipe',
    })
    return ws
  }

  function hostChecks(ws, kind) {
    if (kind === 'ordinary-bug') return gradeOrdinaryBugHostChecks(ws, packageRoot)
    if (kind === 'multi-file') return gradeMultiFileHostChecks(ws, packageRoot)
    throw new Error(`unsupported host check kind: ${kind}`)
  }

  const redactedRunRecords = []

  function baseEnv(ws) {
    return {
      ...buildOpenRouterDeepSeekLiveEnv(process.env, model),
      BABEL_ROOT: repoRoot,
      BABEL_RUNS_DIR: ephemeralRunsRoot,
      BABEL_ALLOWED_ROOTS: ws,
      BABEL_OPENCLAW_APPROVED_ROOTS: ws,
    }
  }

  function runChat(id, ws, prompt, extra = []) {
    const t0 = Date.now()
    const fixtureCli = options.runChatCliFixture?.({ id, ws, prompt, extra })
    const cli = fixtureCli ??
      runBabelCli(
      [
        'run',
        '--mode',
        'chat-headless',
        '--json',
        '--yes',
        '--project-root',
        ws,
        '--model',
        routeKey,
        ...extra,
        prompt,
      ],
      {
        projectRoot: ws,
        offlineDemo: false,
        cwd: packageRoot,
        cliEntry: join(packageRoot, 'dist/index.js'),
        env: baseEnv(ws),
        timeoutMs: 240000,
        ensureDist: 'ensure',
      },
      )
    const { row, redactedRecord, stopScan } = buildChatQualificationArtifacts(
      id,
      ws,
      cli,
      redactSecret,
      packageRoot,
      t0,
    )
    redactedRunRecords.push(redactedRecord)
    report.results.push(row)
    if (stopScan.stop) {
      const err = new Error(`provider_stop:${stopScan.matches[0]}`)
      err.providerError = stopScan.matches[0]
      throw err
    }
    return row
  }

  const report = {
    schema: 'openrouter-lane-647e/live-trial/v1',
    trial_label: trialLabel,
    phases_executed: ['paid_provider_execution'],
    pre_501_evidence_preserved: pre501EvidenceNote,
    main_merge_sha: mainMergeSha,
    qualification_head_sha: execSync(`git -C ${repoRoot} rev-parse HEAD`, { encoding: 'utf8' }).trim(),
    build_provenance: {
      dist_gate: 'ensure',
      dist_exists: distReport.distExists,
      dist_stale: distReport.isStale,
      dist_reason: distReport.reason,
    },
    route_key: routeKey,
    provider: resolved.provider,
    provider_model_id: model,
    adapter: 'OpenRouterApiRunner',
    provider_errors: [],
    stopped_billable: false,
    results: [],
  }

  let repairWs = ''
  let repairSession = null

  if (!options.cancellationOnly) {
    try {
      const ws1 = freshWs('ordinary-bug')
      const r1 = runChat('readonly_explain', ws1, 'Explain what this project does. Do not edit any files.')
      r1.host_checks = hostChecks(ws1, 'ordinary-bug')

      repairWs = freshWs('ordinary-bug')
      const r2 = runChat('vague_repair', repairWs, 'fix this')
      r2.host_checks = hostChecks(repairWs, 'ordinary-bug')
      repairSession = r2.session_id

      const ws3 = freshWs('multi-file')
      const r3 = runChat('vague_feature_export', ws3, 'make export work')
      r3.host_checks = hostChecks(ws3, 'multi-file')

      if (repairSession) {
        const r4 = runChat('multiturn_resume', repairWs, 'Run npm test and tell me if everything passes now.', [
          '--execution-scope',
          'conversation',
          '--resume-chat',
          repairSession,
        ])
        r4.host_checks = hostChecks(repairWs, 'ordinary-bug')
        r4.resume_target_session = repairSession
      } else {
        report.results.push({
          phase: 'paid_provider_execution',
          id: 'multiturn_resume',
          status: 'skipped',
          reason: 'no_session_id_from_vague_repair',
        })
      }
    } catch (e) {
      const message = redactSecret(String(e))
      if (!/provider_stop:/.test(message)) {
        report.provider_errors.push(message)
      }
      report.stopped_billable = true
    }
  } else {
    report.phases_executed = ['paid_provider_execution_cancellation_only']
    report.matrix_skipped = true
  }

  if (!report.stopped_billable) {
    const runner = options.createCancellationRunner
      ? options.createCancellationRunner()
      : new OpenRouterApiRunner(model, { maxTokens: 800 }, { env: process.env })
    const ac = new AbortController()
    const probe = await runStreamCancellationProbe(runner, {
      signal: ac.signal,
      abort: () => ac.abort(),
      abortAfterMs: 120,
    })
    probe.message = probe.message ? redactSecret(probe.message) : undefined
    report.results.push(probe)
    redactedRunRecords.push({
      id: probe.id,
      ...captureRedactedCliRecord({ stdout: '', stderr: probe.message ?? '', exitCode: null, payload: null }, redactSecret),
      cancellation_probe: {
        status: probe.status,
        interpretation: probe.interpretation ?? null,
        content_deltas: probe.content_deltas ?? null,
        event_tally: probe.event_tally ?? null,
        latency_ms: probe.latency_ms,
        usage: probe.usage ?? { actual_cost_usd: null, cost_precision: 'unknown' },
        prior_status_reclassified_from: probe.prior_status_reclassified_from ?? null,
      },
    })
    const probeStop = collectProbeProviderStopScan(probe)
    attachProviderStopToResult(probe, probeStop)
    if (probeStop.stop) {
      report.stopped_billable = true
    }
  }

  let cost = 0
  for (const r of report.results) {
    const c = r.usage?.actual_cost_usd
    if (typeof c === 'number') cost += c
    else if (typeof r.usage?.estimated_cost_usd === 'number') cost += r.usage.estimated_cost_usd
  }
  report.aggregate_known_cost_usd = cost
  report.provider_errors_observed = countAggregateProviderErrors(report)
  report.verdict = report.stopped_billable ? 'provider_stop' : 'provider_calls_completed'

  const recordsPath =
    options.redactedRunRecordsPath ??
    join(
      packageRoot,
      'fixtures/openrouter-lane-647e/evidence/post-501-trial/redacted-run-records',
      `${trialLabel}.json`,
    )
  mkdirSync(dirname(recordsPath), { recursive: true })
  writeFileSync(
    recordsPath,
    JSON.stringify(
      {
        schema: 'openrouter-lane-647e/redacted-run-records/v1',
        trial_label: trialLabel,
        qualification_head_sha: report.qualification_head_sha,
        main_merge_sha: mainMergeSha,
        records: redactedRunRecords,
      },
      null,
      2,
    ) + '\n',
  )
  report.redacted_run_records_path =
    options.redactedRunRecordsPath ??
    `fixtures/openrouter-lane-647e/evidence/post-501-trial/redacted-run-records/${trialLabel}.json`

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

  if (options.runsDir === undefined) {
    rmSync(ephemeralRunsRoot, { recursive: true, force: true })
  }

  return report
}
