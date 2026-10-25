/**
 * H4 — general-purpose artifact deliverable on an explicit ephemeral project workspace.
 * Proves the existing project-scoped grant (non-Git disposable root); no conversation upgrade.
 *
 * Scope split (review):
 * - **Artifact delivery / scope:** native tools may read sources and write deliverables inside the
 *   granted project root (file bytes + mutation-path containment); not completion certification.
 * - **Completion:** execute CHANGE keeps normal task-class verification (`required`) and headless
 *   hard-gate honesty; without an authoritative verifier, completion correctly ends blocked
 *   (`BLOCKED_POLICY`) — not evidence of successful journey completion (P09/P10).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, win32 as pathWin32 } from 'node:path'
import test from 'node:test'
import { ChatEngine } from './chatEngine.js'
import type { ChatEvent } from './chatEngine.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { refreshDryRunState } from '../localTools.js'

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'h4-artifact-fixture',
  family: 'h4-artifact-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'h4-artifact-fixture',
  provider: 'deepinfra',
  providerModelId: 'h4-artifact-fixture-model',
  expensive: false,
  enabled: true,
  experimental: true,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
}

const MANAGED_ENV = [
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_DOCKER_DISABLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_DIRTY_TREE',
] as const

/** Authoritative terminal when headless completion gate blocks after writes without verifier. */
const ARTIFACT_HEADLESS_COMPLETION_BLOCKED_OUTCOMES = new Set<TerminalOutcome>([
  'BLOCKED_POLICY',
])

const SOURCE_ALPHA = 'Aspen v2 requires 6 GiB RAM for the batch job.'
const SOURCE_BETA = 'Birch v2 requires 4 GiB RAM for the same workload.'

function applyBenchmarkFixtureEnv(leaseObjective: string): void {
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_DIRTY_TREE'] = '0'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: `h4-artifact-${randomUUID()}`,
    scope: { repository: 'h4-artifact-fixture', objective: leaseObjective },
    allowedCapabilities: ['edit_task_files', 'inspect_repository', 'run_local_command', 'run_tests'],
  })
  refreshDryRunState()
}

function seedNonGitWorkspace(workspace: string): { reportRel: string; summaryRel: string } {
  mkdirSync(join(workspace, 'sources'), { recursive: true })
  mkdirSync(join(workspace, 'deliverables'), { recursive: true })
  writeFileSync(join(workspace, 'sources', 'alpha.md'), `# Alpha\n${SOURCE_ALPHA}\n`, 'utf8')
  writeFileSync(join(workspace, 'sources', 'beta.md'), `# Beta\n${SOURCE_BETA}\n`, 'utf8')
  assert.equal(existsSync(join(workspace, '.git')), false, 'workspace must not be a Git repository')
  return { reportRel: 'deliverables/report.html', summaryRel: 'deliverables/summary.md' }
}

function buildSourcedHtmlReport(): string {
  return `<!doctype html>
<html lang="en">
<head><title>Memory comparison</title></head>
<body>
<h1>Memory comparison</h1>
<table>
<caption>Requirements</caption>
<tr><th scope="col">Option</th><th scope="col">Memory</th></tr>
<tr><th scope="row">Aspen</th><td>6 GiB</td></tr>
<tr><th scope="row">Birch</th><td>4 GiB</td></tr>
</table>
<section><h2>Sources</h2>
<p data-source="alpha">${SOURCE_ALPHA}</p>
<p data-source="beta">${SOURCE_BETA}</p>
</section>
<section><h2>Conclusion</h2>
<p>Birch needs 2 GiB less memory than Aspen for this workload.</p>
</section>
</body>
</html>`
}

function buildSourcedMarkdownSummary(): string {
  return [
    '# Summary',
    '',
    `- Alpha: ${SOURCE_ALPHA}`,
    `- Beta: ${SOURCE_BETA}`,
    '',
    '## Conclusion',
    'Birch needs 2 GiB less memory than Aspen for this workload.',
    '',
  ].join('\n')
}

/**
 * File/shape regression on disk (regex/string only). Shared scripted constants —
 * not parse/render validation or independent semantic quality (P09/P10).
 */
function assertHtmlArtifactFileShapeRegression(html: string): void {
  assert.match(html, /<table\b/i, 'HTML file must include a table element')
  assert.match(html, /<th[^>]*scope="col"/i, 'HTML file must expose column header markup')
  assert.ok(html.includes(SOURCE_ALPHA), 'HTML file must contain alpha source string')
  assert.ok(html.includes(SOURCE_BETA), 'HTML file must contain beta source string')
  assert.ok(html.includes('6 GiB') && html.includes('4 GiB'), 'HTML file must contain scripted memory strings')
  assert.doesNotMatch(html, /\.pptx|powerpoint/i, 'fixture does not claim PPTX/media deliverables')
}

function assertMarkdownArtifactFileShapeRegression(markdown: string): void {
  assert.match(markdown, /^# Summary/m, 'markdown file must include summary heading')
  assert.ok(markdown.includes(SOURCE_ALPHA) && markdown.includes(SOURCE_BETA), 'markdown file must contain scripted source strings')
  assert.match(markdown, /^## Conclusion/m, 'markdown file must include conclusion heading')
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function buildRunner(plan: ToolStreamEvent[][]): {
  runner: {
    executeWithToolsStream: () => AsyncGenerator<ToolStreamEvent>
    execute: () => Promise<{ type: 'completion'; answer: string }>
    executeRaw: () => Promise<string>
    getLastInvocationMetadata: () => null
    buildNativeToolsWireBody: () => string
    getNativeRequestReservedCompletionTokens: () => number
  }
} {
  let turn = 0
  return {
    runner: {
      async *executeWithToolsStream() {
        const batch = plan[Math.min(turn, plan.length - 1)] ?? []
        turn++
        for (const event of batch) yield event
      },
      async execute() {
        return { type: 'completion', answer: 'Report saved to deliverables/.' }
      },
      async executeRaw() {
        return 'Report saved to deliverables/.'
      },
      getLastInvocationMetadata() {
        return null
      },
      buildNativeToolsWireBody() {
        return '{}'
      },
      getNativeRequestReservedCompletionTokens() {
        return 4_096
      },
    },
  }
}

function isPathContainedInRoot(root: string, candidatePath: string): boolean {
  const rootResolved = resolve(root)
  const abs = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(rootResolved, candidatePath)
  const rel = relative(rootResolved, abs)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const segments = rel.split(/[/\\]/).filter(segment => segment.length > 0)
  return !segments.includes('..')
}

function assertPathContainedInRoot(root: string, candidatePath: string, message?: string): void {
  assert.ok(
    isPathContainedInRoot(root, candidatePath),
    message ?? `mutation path must stay inside workspace: ${candidatePath}`,
  )
}

function isPathContainedInRootWin32(root: string, candidatePath: string): boolean {
  const rootResolved = pathWin32.resolve(root)
  const abs = pathWin32.isAbsolute(candidatePath)
    ? pathWin32.resolve(candidatePath)
    : pathWin32.resolve(rootResolved, candidatePath)
  const rel = pathWin32.relative(rootResolved, abs)
  if (rel === '') return true
  if (pathWin32.isAbsolute(rel)) return false
  const segments = rel.split('\\').filter(segment => segment.length > 0)
  return !segments.includes('..')
}

function assertHeadlessCompletionBlockedAfterArtifactDelivery(events: ChatEvent[]): TerminalOutcome {
  const outcome = assertAuthoritativeTerminalOutcome(events, ARTIFACT_HEADLESS_COMPLETION_BLOCKED_OUTCOMES)
  const terminal = events.find(event => event.type === 'done' || event.type === 'failed')
  assert.equal(terminal?.type, 'done', 'expected a done terminal carrying blocked completion authority')
  if (terminal?.type === 'done') {
    assert.equal(terminal.status, 'blocked', 'headless required-policy completion must not soft-allow without verifier')
    assert.match(
      terminal.answer,
      /verifier|completion gate|Gate blocked/i,
      'blocked answer must cite verifier/completion gate (not mere file existence)',
    )
  }
  return outcome
}

function assertAuthoritativeTerminalOutcome(
  events: ChatEvent[],
  allowed: ReadonlySet<TerminalOutcome>,
): TerminalOutcome {
  const terminal = events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type))
  assert.equal(terminal.length, 1, `expected one terminal event, got ${terminal.map(e => e.type).join(',')}`)
  const event = terminal[0]
  assert.notEqual(event?.type, 'cancelled', 'cancelled terminal is not authoritative fulfillment')
  assert.ok(event?.type === 'done' || event?.type === 'failed', `unexpected terminal type: ${event?.type}`)
  const outcome = event.type === 'done' ? event.outcome : event.outcome
  assert.ok(outcome !== undefined, 'terminal must include an authoritative outcome')
  assert.notEqual(outcome, 'VERIFIED_COMPLETE')
  assert.ok(allowed.has(outcome), `outcome ${outcome} not in allowed set ${[...allowed].join(',')}`)
  return outcome
}

function assertMutationsStayInWorkspace(
  workspace: string,
  log: Array<{ tool: string; target?: string; exit_code?: number }>,
): void {
  for (const entry of log) {
    if (entry.exit_code !== 0) continue
    if (!['write_file', 'str_replace', 'apply_patch'].includes(entry.tool)) continue
    const target = entry.target?.trim()
    if (!target) continue
    assertPathContainedInRoot(workspace, target)
  }
}

test('H4: path containment helper rejects parent escape (win32 paths)', () => {
  const root = 'C:\\fixture\\artifact'
  assert.equal(isPathContainedInRootWin32(root, 'deliverables\\report.html'), true)
  assert.equal(isPathContainedInRootWin32(root, 'C:\\outside\\escaped.html'), false)
  assert.equal(isPathContainedInRootWin32(root, '..\\outside\\escaped.html'), false)
})

test('H4: ephemeral non-Git project workspace writes sourced artifacts; headless completion blocks without verifier', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const workspace = mkdtempSync(join(tmpdir(), 'babel-h4-artifact-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(workspace, { recursive: true, force: true })
  })

  applyBenchmarkFixtureEnv('sourced artifact report without Git')
  const { reportRel, summaryRel } = seedNonGitWorkspace(workspace)
  const alphaBytesBefore = readFileSync(join(workspace, 'sources', 'alpha.md'))
  const betaBytesBefore = readFileSync(join(workspace, 'sources', 'beta.md'))
  const htmlBody = buildSourcedHtmlReport()
  const mdBody = buildSourcedMarkdownSummary()

  const { runner } = buildRunner([
    [
      { type: 'tool_use', id: 'read-alpha', name: 'read_file', input: { path: 'sources/alpha.md' } },
      { type: 'tool_use', id: 'read-beta', name: 'read_file', input: { path: 'sources/beta.md' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      {
        type: 'tool_use',
        id: 'write-html',
        name: 'write_file',
        input: { path: reportRel, content: htmlBody },
      },
      {
        type: 'tool_use',
        id: 'write-md',
        name: 'write_file',
        input: { path: summaryRel, content: mdBody },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      {
        type: 'text_delta',
        text: 'VERIFIED_COMPLETE: sourced HTML and markdown reports are fully verified and published.',
      },
      { type: 'done', finishReason: 'stop' },
    ],
  ])

  const engine = new ChatEngine({
    task: 'Read sources/alpha.md and sources/beta.md; write deliverables/report.html and deliverables/summary.md with cited facts.',
    projectRoot: workspace,
    executionScope: { kind: 'project', projectRoot: workspace },
    runId: `h4-artifact-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 6,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(
    'Read sources/alpha.md and sources/beta.md; write deliverables/report.html and deliverables/summary.md with cited facts.',
  ))

  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; target?: string; exit_code?: number; error?: string }>
  }).toolCallLog
  const reads = log.filter(entry => entry.tool === 'read_file')
  assert.equal(reads.length >= 2, true)
  assert.equal(reads.every(entry => entry.exit_code === 0), true)
  const writes = log.filter(entry => entry.tool === 'write_file')
  assert.equal(writes.length >= 2, true)
  assert.equal(writes.every(entry => entry.exit_code === 0), true)
  assertMutationsStayInWorkspace(workspace, log)

  assert.equal(existsSync(join(workspace, reportRel)), true, 'artifact delivery: report file must exist on disk')
  assert.equal(existsSync(join(workspace, summaryRel)), true, 'artifact delivery: summary file must exist on disk')
  const html = readFileSync(join(workspace, reportRel), 'utf8')
  const markdown = readFileSync(join(workspace, summaryRel), 'utf8')
  assertHtmlArtifactFileShapeRegression(html)
  assertMarkdownArtifactFileShapeRegression(markdown)
  assert.equal(readFileSync(join(workspace, 'sources', 'alpha.md')).compare(alphaBytesBefore), 0)
  assert.equal(readFileSync(join(workspace, 'sources', 'beta.md')).compare(betaBytesBefore), 0)

  assertHeadlessCompletionBlockedAfterArtifactDelivery(events)
})

test('H4: conversation scope denies project tools and leaves workspace artifacts untouched', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const workspace = mkdtempSync(join(tmpdir(), 'babel-h4-conversation-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(workspace, { recursive: true, force: true })
  })

  applyBenchmarkFixtureEnv('conversation scope control')
  const { reportRel } = seedNonGitWorkspace(workspace)
  const alphaBytesBefore = readFileSync(join(workspace, 'sources', 'alpha.md'))
  const betaBytesBefore = readFileSync(join(workspace, 'sources', 'beta.md'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'babel-h4-outside-'))

  const { runner } = buildRunner([
    [
      { type: 'tool_use', id: 'read-alpha', name: 'read_file', input: { path: 'sources/alpha.md' } },
      {
        type: 'tool_use',
        id: 'escape-write',
        name: 'write_file',
        input: { path: join(outsideRoot, 'escaped.html'), content: '<html>escaped</html>' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Report complete.' }, { type: 'done', finishReason: 'stop' }],
  ])

  const engine = new ChatEngine({
    task: 'Write deliverables/report.html from the sources.',
    projectRoot: null,
    executionScope: { kind: 'conversation' },
    runId: `h4-conversation-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 4,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(
    'Write deliverables/report.html from the sources.',
  ))
  const terminal = events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type))
  assert.equal(terminal.length, 1)
  const event = terminal[0]
  assert.ok(event?.type === 'done' || event?.type === 'failed')
  if (event?.type === 'done') {
    assert.equal(event.status, 'blocked')
    assert.ok(event.answer.includes('PROJECT_REQUIRED'))
    assert.notEqual(event.outcome, 'VERIFIED_COMPLETE')
  }

  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; exit_code?: number; error?: string }>
  }).toolCallLog
  assert.equal(log.every(entry => entry.exit_code !== 0), true, 'conversation scope must not complete project tools')
  assert.match(log.map(entry => `${entry.error ?? ''}`).join('\n'), /PROJECT_REQUIRED/i)
  assert.equal(existsSync(join(workspace, reportRel)), false)
  assert.equal(existsSync(join(outsideRoot, 'escaped.html')), false)
  assert.equal(readFileSync(join(workspace, 'sources', 'alpha.md')).compare(alphaBytesBefore), 0)
  assert.equal(readFileSync(join(workspace, 'sources', 'beta.md')).compare(betaBytesBefore), 0)
  rmSync(outsideRoot, { recursive: true, force: true })
})

test('H4: project scope rejects path escape outside ephemeral workspace', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const workspace = mkdtempSync(join(tmpdir(), 'babel-h4-escape-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'babel-h4-escape-out-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  })

  applyBenchmarkFixtureEnv('workspace escape must fail closed')
  seedNonGitWorkspace(workspace)

  const { runner } = buildRunner([
    [
      {
        type: 'tool_use',
        id: 'escape-write',
        name: 'write_file',
        input: { path: join(outsideRoot, 'escaped.html'), content: '<html>escaped</html>' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Done.' }, { type: 'done', finishReason: 'stop' }],
  ])

  const engine = new ChatEngine({
    task: 'Do not write outside the workspace.',
    projectRoot: workspace,
    executionScope: { kind: 'project', projectRoot: workspace },
    runId: `h4-escape-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 4,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  await collectStream(engine.submitMessageStream('Do not write outside the workspace.'))

  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; exit_code?: number }>
  }).toolCallLog
  const escape = log.find(entry => entry.tool === 'write_file')
  assert.ok(escape)
  assert.notEqual(escape.exit_code, 0, 'write outside workspace must be denied')
  assert.equal(existsSync(join(outsideRoot, 'escaped.html')), false)
  assertMutationsStayInWorkspace(workspace, log)
})
