/** Native Chat execution plus host-owned artifact grading; never trusts success prose. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ChatResult } from '../agent/chatEngine.js'
import { isCredentialTargetPath } from '../authority/protectedPath.js'
import { freezeEvaluator, runJourney, type JourneyGrade, type JourneySpec, type OracleVerdict } from './harness-journey-contract.js'
import { captureJourneyGitState, prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'
import { gradeJourneyCode } from './harness-journey-code-oracle.js'
import { gradeInCleanRoom } from './cleanRoomGrade.js'
import { calibrationFileReferences, calibrationPolicy, createCalibrationRunner } from './native-chat-calibration.js'
import type { NativeTaskOperation, NativeTaskTerminal } from './native-chat-cli.js'
import { runGitCommand } from '../utils/gitExec.js'

const TaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), journeyId: z.enum(['J03', 'J04', 'J05', 'J06']),
  kind: z.enum(['read_only', 'bug_fix', 'feature', 'negative_control']),
  fixtureMode: z.enum(['clean-preserved-content']).optional(), allowedChanges: z.array(z.string()),
}).strict()
const ManifestSchema = z.object({ schemaVersion: z.literal(1), version: z.string().min(1), expansionTarget: z.number().int().min(12).max(20), tasks: z.array(TaskSchema).min(4) }).strict()
type Terminal = Pick<ChatResult, 'status' | 'outcome' | 'answer'>
const successOutcomes = new Set(['VERIFIED_COMPLETE', 'UNVERIFIED_PATCH', 'NO_CHANGE_REQUIRED'])
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Relations, rather than token presence, establish the two requested corrections. */
export function gradeNativeInspection(answer: string, evidence: { projectRoot: string; operations: readonly NativeTaskOperation[] }): OracleVerdict {
  const schema = z.object({ corrections: z.array(z.object({ stale: z.string(), current: z.string() }).strict()).length(2) }).strict()
  try {
    const trimmed = answer.trim()
    const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
    const parsed = schema.parse(JSON.parse(fenced?.[1] ?? trimmed))
    const actual = parsed.corrections.map(item => `${item.stale}:${item.current}`).sort()
    const expected = ['src/client:apps/web/main.mjs', 'src/server:packages/api/server.mjs'].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return 'fail'
    const inspected = ['REPO_MAP.md', 'apps/web/main.mjs', 'packages/api/server.mjs'].every(path => evidence.operations.some(operation => {
      if (operation.tool !== 'read_file' || !operation.completed || operation.exitCode !== undefined && operation.exitCode !== 0) return false
      const target = operation.target.replaceAll('\\', '/').replace(/^\/(?:project|app)(?:\/|$)/i, '')
      const observed = resolve(evidence.projectRoot, target)
      const required = resolve(evidence.projectRoot, path)
      return process.platform === 'win32' ? observed.toLowerCase() === required.toLowerCase() : observed === required
    }))
    return inspected ? 'pass' : 'fail'
  } catch { return 'fail' }
}

/** Copy bounded regular-file bytes after engine settlement. Never follow links. */
export async function captureNativeTaskFiles(root: string, modes: Map<string, number> = new Map()): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  let bytes = 0
  let objects = 0
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe candidate root')
  modes.set('.', rootInfo.mode & 0o7777)
  async function walk(directory: string): Promise<void> {
    for (const item of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = directory ? `${directory}/${item.name}` : item.name
      // Git bytes have a separate integrity check; retain their modes here.
      const metadata = path === '.git' || path.startsWith('.git/')
      if (++objects > 512) throw new Error('Unsafe candidate object count')
      if (isCredentialTargetPath(path)) throw new Error('Unsafe candidate credential target')
      const stat = await lstat(join(root, path))
      if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('Unsafe candidate link')
      if (stat.isDirectory()) { modes.set(`${path}/`, stat.mode & 0o7777); await walk(path); continue }
      if (metadata) {
        if (!stat.isFile()) throw new Error('Unsafe candidate metadata object')
        modes.set(path, stat.mode & 0o7777)
        continue
      }
      if (!stat.isFile() || stat.size > 1_048_576 || files.size >= 256 || bytes + stat.size > 4_194_304) throw new Error('Unsafe candidate capture size or object')
      const content = await readFile(join(root, path))
      bytes += content.length
      if (bytes > 4_194_304) throw new Error('Unsafe candidate capture size')
      files.set(path, Buffer.from(content))
      modes.set(path, stat.mode & 0o7777)
    }
  }
  await walk('')
  return files
}

/** Preserve file permissions as well as bytes, including changes Git ignores. */
export function nativeChangedPaths(baseline: ReadonlyMap<string, string>, beforeModes: ReadonlyMap<string, number>, snapshot: ReadonlyMap<string, Buffer>, afterModes: ReadonlyMap<string, number>): string[] {
  return [...new Set([...baseline.keys(), ...snapshot.keys(), ...beforeModes.keys(), ...afterModes.keys()])].filter(path =>
    baseline.get(path) !== (snapshot.has(path) ? digest(snapshot.get(path)!) : undefined) ||
    beforeModes.get(path) !== afterModes.get(path) && path !== '.git/index')
}

/** Separate native completion, artifact correctness, missing evidence and calibration. */
export function scoreNativeTask(terminal: Terminal | null, verdict: OracleVerdict, calibration: boolean): {
  outcome: 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'CALIBRATION_PASS'
  acceptedCompletion: boolean
  falseCompletion: boolean
} {
  const completed = terminal?.status === 'completed' && successOutcomes.has(terminal.outcome ?? '')
  const claimed = ['VERIFIED_COMPLETE', 'NO_CHANGE_REQUIRED'].includes(terminal?.outcome ?? '') || /\b(?:task complete|implemented and verified)\b/i.test(terminal?.answer ?? '')
  return {
    outcome: !terminal || verdict === 'unavailable' ? 'UNAVAILABLE' : verdict === 'pass' && calibration ? 'CALIBRATION_PASS' : verdict === 'pass' && completed ? 'PASS' : 'FAIL',
    acceptedCompletion: !calibration && completed && verdict === 'pass',
    falseCompletion: claimed && (verdict === 'fail' || !completed),
  }
}

function git(root: string, args: string[]): string {
  const result = runGitCommand(args, root, { timeoutMs: 10_000 })
  if (result.status !== 0) throw new Error('Evaluator Git identity unavailable')
  return result.stdout.trim()
}

/** A running Docker daemon does not prove its bind mounts contain host fixtures. */
export function nativeGraderReady(image: string | undefined): boolean {
  if (!image) return false
  try {
    const result = gradeInCleanRoom({ startFiles: [], candidateDiffFiles: [],
      oracleFiles: [{ relativePath: 'grader-ready.mjs', contents: 'process.stdout.write("native-grader-ready")' }],
      verifierCommand: ['node', 'grader-ready.mjs'], execution: { kind: 'docker', image },
    })
    return result.execution_status === 'completed' && result.exit_code === 0 && result.stdout === 'native-grader-ready'
  } catch { return false }
}

/** Run a bounded public development corpus through native Chat with isolated scoring. */
export async function runNativeChatTasks(options: {
  out: string
  mode: 'calibration' | 'live'
  codeImage?: string
  model?: string
}): Promise<Record<string, unknown>> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const out = resolve(options.out)
  const outputRelative = relative(root, out)
  if (!(outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative))) throw new Error('Evidence must be outside the source checkout')
  const manifestPath = join(root, 'benchmarks/harness-journeys/native-chat-tasks.json')
  const corpusPath = join(root, 'benchmarks/harness-journeys/development.json')
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (new Set(manifest.tasks.map(task => task.id)).size !== manifest.tasks.length) throw new Error('Duplicate native task id')
  const corpus = await readJourneyCorpus(corpusPath)
  const sha = git(root, ['rev-parse', 'HEAD'])
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  const specs: JourneySpec[] = manifest.tasks.map(task => {
    const source = corpus.journeys.find(spec => spec.id === task.journeyId)
    if (!source) throw new Error('Missing development journey')
    return { ...source, id: task.id, prompt: source.prompt + (task.kind === 'read_only'
      ? '\nRead REPO_MAP.md and the two current source files. Return only JSON with a corrections array of objects, each containing stale and current path strings.' : '') }
  })
  // Freeze the grading dependency closure and public data before any candidate acts.
  const protectedFiles = [manifestPath, corpusPath, join(root, 'babel-cli/scripts/run_native_chat_tasks.mjs'), join(root, 'babel-cli/package-lock.json'), ...[
    'native-chat-tasks.ts', 'native-chat-calibration.ts', 'native-chat-cli.ts', 'harness-journey-contract.ts',
    'harness-journey-fixtures.ts', 'harness-journey-code-oracle.ts', 'harness-journey-checks.ts', 'cleanRoomGrade.ts',
    '../config/benchmarkContainer.ts', '../config/dockerIsolationArgs.ts', '../config/executionProfiles.ts',
    '../authority/protectedPath.ts', '../authority/commandSpec.ts', '../authority/literalSearch.ts',
    '../authority/unprivilegedChildEnv.ts', '../utils/commandArgv.ts', '../utils/safeEnv.ts', '../utils/gitExec.ts',
  ].map(path => join(root, 'babel-cli/src/eval', path))]
  const sourceHashes = await Promise.all(protectedFiles.map(async path => ({ path: relative(root, path).replaceAll('\\', '/'), sha256: digest(await readFile(path)) })))
  const calibration = options.mode === 'calibration'
  // The offline process never consults ambient provider configuration or keys.
  // Live runs retain production defaults, limits and permission/sandbox policy.
  if (calibration) {
    const { installNoAmbientInferenceGuard } = await import('../testinfra/no-ambient-inference.mjs')
    process.env['BABEL_TESTS_ALLOW_INFERENCE'] = '0'
    installNoAmbientInferenceGuard()
    process.env['BABEL_BENCHMARK_MODE'] = '1'
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
    process.env['BABEL_DRY_RUN'] = '0'
    process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
    process.env['BABEL_COMPACTION'] = 'off'
  }
  await mkdir(out)
  process.env['BABEL_RUNS_DIR'] = join(out, 'runs')
  const graderReady = calibration ? null : nativeGraderReady(options.codeImage)
  const tasks: Record<string, unknown>[] = []
  let priorUnsettled = false
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index]!
    const task = manifest.tasks[index]!
    const sourceFixture = corpus.fixtures[spec.fixtureId]!
    const fixture = task.fixtureMode === 'clean-preserved-content'
      ? { ...sourceFixture, files: { ...sourceFixture.files, ...sourceFixture.dirtyFiles, ...sourceFixture.untrackedFiles }, dirtyFiles: {}, untrackedFiles: {} }
      : sourceFixture
    const cell = await prepareJourneyFixture(spec, fixture, join(out, task.id))
    let terminal: NativeTaskTerminal | null = null
    let routes: unknown[] = []
    let verifierExitCode: number | null = null
    let operationCount = 0
    let answer = ''
    let snapshot = new Map<string, Buffer>()
    const snapshotModes = new Map<string, number>()
    const baselineModes = new Map<string, number>()
    await captureNativeTaskFiles(cell.candidateRoot, baselineModes)
    let captured = false
    const operations: NativeTaskOperation[] = []
    const diagnostics: string[] = []
    const changedPaths: string[] = []
    let oracleVerdict: OracleVerdict = 'unavailable'
    let launched = false
    let regression: boolean | null = null
    const baseline = new Map(cell.files.map(file => [file.path, file.sha256]))
    const evaluate = async (): Promise<JourneyGrade> => {
      if (!captured) return { verdict: 'unavailable', fulfillment: 'incomplete', evidenceRefs: [] }
      if (!calibration && routes.length === 0) {
        diagnostics.push('live_provider_route_evidence_unavailable')
        return { verdict: 'unavailable', fulfillment: 'incomplete', evidenceRefs: [] }
      }
      changedPaths.push(...nativeChangedPaths(baseline, baselineModes, snapshot, snapshotModes))
      const unauthorized = changedPaths.filter(path => !task.allowedChanges.includes(path))
      const metadata = cell.gitMetadataDigest ? await captureJourneyGitState(cell.candidateRoot, cell.gitMetadataDigest) : null
      if (unauthorized.length || metadata && metadata.metadataDigest !== cell.gitMetadataDigest) {
        regression = true
        oracleVerdict = 'fail'
        diagnostics.push('unauthorized_change_or_git_metadata_change')
      } else if (task.kind === 'read_only') {
        oracleVerdict = gradeNativeInspection(answer, { projectRoot: cell.candidateRoot, operations })
      } else if (calibration) {
        // Only fixed reference controls use byte equality. Arbitrary candidate
        // code is never imported or evaluated on the host to avoid Docker.
        const expected = calibrationFileReferences[task.journeyId]
        oracleVerdict = expected && Object.entries(expected).every(([path, content]) => snapshot.get(path)?.toString('utf8') === content)
          ? 'pass' : 'fail'
      } else {
        oracleVerdict = await gradeJourneyCode(task.journeyId, async path => {
          const bytes = snapshot.get(path)
          if (!bytes) throw new Error('Captured file missing')
          return { bytes: Buffer.from(bytes), evidenceRef: `${task.id}/protected/snapshot.json#${path}` }
        }, options.codeImage)
      }
      return { verdict: oracleVerdict, fulfillment: oracleVerdict === 'pass' ? 'complete' : 'incomplete', evidenceRefs: [`${task.id}/protected/snapshot.json`] }
    }
    const evaluator = await freezeEvaluator({ revision: sha, specs: [spec], protectedFiles, evaluate })
    const result = await runJourney(spec, {
      id: calibration ? 'native-chat-scripted-calibration' : 'native-chat-production',
      async execute(input) {
        if (priorUnsettled) { diagnostics.push('prior_unsettled_execution'); return }
        if (!calibration && task.kind === 'negative_control') { diagnostics.push('negative_control_requires_scripted_calibration'); return }
        if (!calibration && task.kind !== 'read_only' && !graderReady) { diagnostics.push('isolated_grader_unavailable'); return }
        launched = true
        if (!calibration) {
          const { runNativeCliTask } = await import('./native-chat-cli.js')
          let live: ReturnType<typeof runNativeCliTask>
          try {
            live = runNativeCliTask({ root, projectRoot: cell.candidateRoot, runsRoot: join(out, 'runs'), prompt: input.prompt,
              ...(options.model ? { model: options.model } : {}),
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : ''
            diagnostics.push(/^native_cli_[a-z0-9_:]+$/.test(message) ? message : 'native_cli_preparation_unavailable')
            throw new Error('Native CLI execution unavailable')
          }
          terminal = live.terminal
          operations.push(...live.operations)
          operationCount = operations.length
          routes = live.routes
          verifierExitCode = live.verifierExitCode
          answer = terminal.answer
        } else {
          const { ChatEngine } = await import('../agent/chatEngine.js')
          const engine = new ChatEngine({
          task: input.prompt, projectRoot: cell.candidateRoot, runId: `native-eval-${randomUUID()}`,
          ...(task.kind === 'read_only' ? { operation: 'READ_ONLY' as const } : {}),
          providerRunner: createCalibrationRunner(task.journeyId, task.kind === 'negative_control'), providerPolicy: calibrationPolicy,
          model: 'synthetic-calibration', maxTurns: task.journeyId === 'J04' ? 8 : 4,
          })
          terminal = await engine.submitMessage(input.prompt, {
          onAnswerChunk(chunk) { answer += chunk },
          onToolStart(tool, target) { operations.push({ tool, target, completed: false }); return operationCount++ },
          onToolComplete(id, _detail, error, exitCode) {
            if (operations[id]) {
              operations[id]!.completed = error === undefined && (exitCode === undefined || exitCode === 0)
              if (exitCode !== undefined) operations[id]!.exitCode = exitCode
            }
          },
          })
          answer = terminal.answer || answer
        }
        // Snapshot only after native task settlement; never re-run an ambiguous request.
        snapshot = await captureNativeTaskFiles(cell.candidateRoot, snapshotModes)
        captured = true
        await writeFile(join(cell.protectedRoot, 'snapshot.json'), JSON.stringify({ modes: Object.fromEntries(snapshotModes), files: [...snapshot].map(([path, bytes]) => ({ path, sha256: digest(bytes), base64: bytes.toString('base64') })) }), { flag: 'wx' })
      },
      observe() { return { routeReceipt: null, interventions: [], usage: null, evidenceRefs: [`${task.id}/protected/observation.json`] } },
    }, evaluator)
    // An execution exception may hide partial delivery or effects. Preserve the
    // attempted row and stop admitting later live requests, without replay.
    if (result.lifecycle === 'failed') priorUnsettled = true
    const settled = terminal as NativeTaskTerminal | null
    const verdict: OracleVerdict = result.oracleVerdict
    const score = scoreNativeTask(settled, verdict, calibration)
    const usage = settled?.usage
    const costKnown = usage?.costComplete === true && Number.isFinite(usage.completeCostUSD)
    const row = {
      id: task.id, kind: task.kind, ...score, lifecycle: result.lifecycle,
      oracleVerdict: verdict, gradingMode: calibration ? 'reference_bytes_calibration' : 'independent_artifact',
      launchStatus: launched ? 'attempted' : 'not_launched',
      evaluatorDigest: evaluator.digest, baselineSha: cell.gitHead, fixtureHashes: cell.files,
      engineStatus: settled?.status ?? null, engineOutcome: settled?.outcome ?? null,
      answer, operationCount, operations, changedPaths, elapsedMs: result.timing.wallMs,
      verificationFailure: verifierExitCode !== null ? verifierExitCode !== 0 : settled?.verifierReceipt ? settled.verifierReceipt.exit_code !== 0 : null,
      regression,
      regressionScope: 'protected_fixture_invariants',
      retryCount: null, routes, requestedModel: calibration ? null : options.model ?? null,
      routing: calibration ? [] : settled?.turnRouting ?? [],
      spend: { provenance: calibration ? 'offline_no_provider_requests' : 'engine_usage', costUsd: calibration ? 0 : costKnown ? usage!.completeCostUSD : null,
        actualCostUsd: calibration ? 0 : usage?.actualCostUSD ?? null, estimatedCostUsd: calibration ? null : usage?.estimatedCostUSD ?? null,
        providerReportedCostUsd: calibration ? null : usage?.reportedCostUSD ?? null, providerInvoiceObserved: false,
        inputTokens: calibration || usage?.usageComplete === false ? null : usage?.totalInputTokens ?? null,
        outputTokens: calibration || usage?.usageComplete === false ? null : usage?.totalOutputTokens ?? null, unknownCost: !calibration && !costKnown },
      diagnostics: [...diagnostics, ...result.diagnostics],
    }
    await writeFile(join(cell.protectedRoot, 'observation.json'), JSON.stringify(row, null, 2), { flag: 'wx' })
    tasks.push(row)
    // Retain every attempted cell before the next candidate starts.
    await writeFile(join(out, `attempt-${index + 1}.json`), JSON.stringify(row, null, 2), { flag: 'wx' })
  }
  const report = {
    schemaVersion: 1, evaluator: { version: manifest.version, sha, dirty, digest: digest(JSON.stringify(sourceHashes)), files: sourceHashes },
    candidate: { sha, dirty, entrypoint: calibration ? 'source_ChatEngine.submitMessage' : 'source_CLI_chat-headless', os: process.platform, node: process.version,
      runtimeLimits: calibration ? 'scripted_control_four_turns' : 'production_defaults_no_evaluator_overrides' },
    mode: options.mode, modelPerformanceClaim: false, providerRequests: calibration ? 0 : null,
    expansionTarget: manifest.expansionTarget, isolatedGraderReady: graderReady, tasks,
    summary: { admittedTasks: tasks.filter(task => task.launchStatus === 'attempted').length, scheduledTasks: tasks.length,
      acceptedCompletions: tasks.filter(task => task.acceptedCompletion).length,
      falseCompletions: tasks.filter(task => task.falseCompletion).length,
      calibrationPasses: tasks.filter(task => task.outcome === 'CALIBRATION_PASS').length,
      unavailable: tasks.filter(task => task.outcome === 'UNAVAILABLE').length },
    limitations: ['Public development tasks, not held-out qualification.', 'Calibration checks reference bytes, not arbitrary program behavior.', 'Live code scoring requires a working isolated grader, including readable bind mounts; unavailable prerequisites prevent live code admission.', 'Read-only grading checks named path facts and preservation, not general explanation quality.', 'Retry and provider-request counts remain unknown when no complete host trace is available.', 'TUI and installed package entrypoints are not exercised.'],
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
  return report
}
