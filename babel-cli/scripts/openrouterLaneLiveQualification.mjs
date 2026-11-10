/**
 * Billable OpenRouter Chat qualification matrix for lane 647e.
 * Uses fresh disposable fixtures, independent host oracles, stop-on-provider-error.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync, execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {{
 *   trialLabel: string
 *   outputPath: string
 *   mainMergeSha?: string
 *   pre501EvidenceNote?: string
 *   runsDir?: string
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

  const { runBabelCli } = await import(pathToFileURL(join(packageRoot, 'src/services/liteTrustDemo.ts')).href)
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
    const checks = {}
    if (kind === 'ordinary-bug') {
      const score = spawnSync(
        process.execPath,
        [join(packageRoot, 'fixtures/coding-output-acceptance/oracle/ordinary-bug/score.mjs'), ws],
        { encoding: 'utf8' },
      )
      checks.oracle_score_exit = score.status
      checks.oracle_stdout = score.stdout.trim().slice(0, 200)
      checks.math_js = readFileSync(join(ws, 'src/math.js'), 'utf8').trim()
      const test = spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8', shell: true })
      checks.npm_test_exit = test.status
    } else {
      const test = spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8', shell: true })
      checks.npm_test_exit = test.status
      checks.has_index_ts = existsSync(join(ws, 'src/index.ts'))
    }
    return checks
  }

  function summarizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null
    return {
      actual_cost_usd: usage.actualCostUSD ?? usage.reportedCostUSD ?? null,
      total_input_tokens: usage.totalInputTokens ?? null,
      total_output_tokens: usage.totalOutputTokens ?? null,
      total_tokens: usage.totalTokens ?? null,
      cost_complete: usage.costComplete ?? null,
      model_breakdown_keys: usage.modelBreakdown ? Object.keys(usage.modelBreakdown) : [],
    }
  }

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
    const cli = runBabelCli(
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
      },
    )
    const blob = redactSecret(`${cli.stderr}\n${cli.stdout}`)
    const providerError = blob.match(/\[(openrouter|OpenRouter)\][^\n]{0,240}/i)?.[0] ?? null
    if (providerError && /\b(401|403|429|5\d\d|ProviderError|provider error)\b/i.test(providerError)) {
      const err = new Error(`provider_stop:${providerError}`)
      err.providerError = providerError
      throw err
    }
    const sessionId =
      typeof cli.payload?.session_id === 'string'
        ? cli.payload.session_id
        : typeof cli.payload?.run_dir === 'string'
          ? cli.payload.run_dir.split('/').pop()
          : null
    return {
      phase: 'paid_provider_execution',
      id,
      latency_ms: Date.now() - t0,
      exit_code: cli.exitCode,
      terminal_outcome: cli.payload?.terminal_outcome ?? null,
      status: cli.payload?.status ?? null,
      session_id: sessionId,
      run_dir_basename: sessionId,
      usage: summarizeUsage(cli.payload?.usage ?? null),
      timed_out: cli.timedOut === true,
      failure_capsule: cli.failureCapsule
        ? { kind: cli.failureCapsule.kind, failure_class_hint: cli.failureCapsule.failure_class_hint }
        : null,
      provider_error_observed: providerError,
    }
  }

  const report = {
    schema: 'openrouter-lane-647e/live-trial/v1',
    trial_label: trialLabel,
    phases_executed: ['paid_provider_execution'],
    pre_501_evidence_preserved: pre501EvidenceNote,
    main_merge_sha: mainMergeSha,
    qualification_head_sha: execSync(`git -C ${repoRoot} rev-parse HEAD`, { encoding: 'utf8' }).trim(),
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

  try {
    const ws1 = freshWs('ordinary-bug')
    const r1 = runChat('readonly_explain', ws1, 'Explain what this project does. Do not edit any files.')
    r1.host_checks = hostChecks(ws1, 'ordinary-bug')
    report.results.push(r1)

    repairWs = freshWs('ordinary-bug')
    const r2 = runChat('vague_repair', repairWs, 'fix this')
    r2.host_checks = hostChecks(repairWs, 'ordinary-bug')
    repairSession = r2.session_id
    report.results.push(r2)

    const ws3 = freshWs('multi-file')
    const r3 = runChat('vague_feature_export', ws3, 'make export work')
    r3.host_checks = hostChecks(ws3, 'multi-file')
    report.results.push(r3)

    if (repairSession) {
      const r4 = runChat('multiturn_resume', repairWs, 'Run npm test and tell me if everything passes now.', [
        '--execution-scope',
        'conversation',
        '--resume-chat',
        repairSession,
      ])
      r4.host_checks = hostChecks(repairWs, 'ordinary-bug')
      r4.resume_target_session = repairSession
      report.results.push(r4)
    } else {
      report.results.push({
        phase: 'paid_provider_execution',
        id: 'multiturn_resume',
        status: 'skipped',
        reason: 'no_session_id_from_vague_repair',
      })
    }
  } catch (e) {
    report.provider_errors.push(redactSecret(String(e)))
    report.stopped_billable = true
  }

  if (!report.stopped_billable) {
    const t0 = Date.now()
    const runner = new OpenRouterApiRunner(model, { maxTokens: 800 }, { env: process.env })
    const ac = new AbortController()
    let deltas = 0
    const timer = setTimeout(() => ac.abort(), 120)
    try {
      for await (const _ev of runner.executeWithToolsStream(
        [{ role: 'user', content: 'Write 20 paragraphs about graph algorithms.' }],
        [],
        { signal: ac.signal },
      )) {
        deltas++
      }
      report.results.push({
        phase: 'paid_provider_execution',
        id: 'cancellation_stream_abort',
        status: 'unexpected_complete',
        deltas,
        latency_ms: Date.now() - t0,
      })
    } catch (e) {
      const meta = runner.getLastInvocationMetadata()
      report.results.push({
        phase: 'paid_provider_execution',
        id: 'cancellation_stream_abort',
        status: 'aborted_or_error',
        message: redactSecret(String(e)).slice(0, 300),
        deltas,
        latency_ms: Date.now() - t0,
        usage: meta
          ? {
              total_tokens: meta.total_tokens,
              estimated_cost_usd: meta.estimated_cost_usd,
              cost_precision: meta.cost_precision,
            }
          : null,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  let cost = 0
  for (const r of report.results) {
    const c = r.usage?.actual_cost_usd
    if (typeof c === 'number') cost += c
    else if (typeof r.usage?.estimated_cost_usd === 'number') cost += r.usage.estimated_cost_usd
  }
  report.aggregate_known_cost_usd = cost
  report.provider_errors_observed = report.provider_errors.length
  report.verdict = report.stopped_billable ? 'provider_stop' : 'provider_calls_completed'

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

  if (options.runsDir === undefined) {
    rmSync(ephemeralRunsRoot, { recursive: true, force: true })
  }

  return report
}
