import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { refreshDryRunState } from '../localTools.js'

const MAINTENANCE_TASK = 'I am onboarding a new analyst who needs to refresh the monthly dashboard safely. The instructions are hard to find. Improve the navigation so a newcomer can reach the current procedure and understand what not to overwrite. Use your judgment for a small, reversible documentation change; keep all existing pages, and do not change scripts or data. Ask only if a choice is genuinely necessary. Explain what changed and what you checked. Do not commit or push.'
const ORIGINAL_README = '# Analytics workspace\n\nSee the monthly dashboard procedure in docs/dashboard-refresh.md.\n'
const UPDATED_README = '# Analytics workspace\n\n## Monthly dashboard\n\n- Follow [the current refresh procedure](docs/dashboard-refresh.md).\n- Preserve source data; do not overwrite the monthly inputs.\n'
const SOURCE_DOC = '# Dashboard refresh\n\nRefresh the dashboard from the monthly inputs. Do not overwrite source data.\n'

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'maintenance-delegation-fixture',
  family: 'maintenance-delegation-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'maintenance-delegation-fixture',
  provider: 'deepinfra',
  providerModelId: 'maintenance-delegation-fixture-model',
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

const ENV_KEYS = [
  'BABEL_RUNS_DIR',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_DOCKER_DISABLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_LITE_OFFLINE',
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_DIRTY_TREE',
] as const

function configureFixture(root: string): void {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env['BABEL_RUNS_DIR'] = join(root, '.runs')
  refreshDryRunState()
}

function buildControlledRunner(plan: ToolStreamEvent[][]) {
  let turn = 0
  return {
    async *executeWithToolsStream() {
      const events = plan[Math.min(turn, plan.length - 1)] ?? []
      turn++
      for (const event of events) yield event
    },
    async execute() {
      return { type: 'completion' as const, answer: 'I updated README.md and checked the rendered section. No tests were run, and I did not commit or push.' }
    },
    async executeRaw() {
      return 'I updated README.md and checked the rendered section. No tests were run, and I did not commit or push.'
    },
    getLastInvocationMetadata() { return null },
    buildNativeToolsWireBody() { return '{}' },
    getNativeRequestReservedCompletionTokens() { return 4_096 },
  }
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('authorized maintenance escapes repeated read-only delegation and reports unverified delivery honestly', async t => {
  const prior = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const root = mkdtempSync(join(tmpdir(), 'babel-maintenance-delegation-'))
  t.after(() => {
    for (const key of ENV_KEYS) {
      const value = prior[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    refreshDryRunState()
    rmSync(root, { recursive: true, force: true })
  })

  configureFixture(root)
  writeFileSync(join(root, 'README.md'), ORIGINAL_README, 'utf8')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs/dashboard-refresh.md'), SOURCE_DOC, 'utf8')

  const repeatedChildRequest = {
    task: 'Inspect docs/dashboard-refresh.md and recommend the README navigation link and data-preservation note.',
    mutation: false,
  }
  const runner = buildControlledRunner([
    [
      { type: 'tool_use', id: 'read-readme', name: 'read_file', input: { path: 'README.md' } },
      { type: 'tool_use', id: 'read-procedure', name: 'read_file', input: { path: 'docs/dashboard-refresh.md' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'ask-child-1', name: 'sub_agent', input: repeatedChildRequest },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'ask-child-2', name: 'sub_agent', input: repeatedChildRequest },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'write-navigation', name: 'write_file', input: { path: 'README.md', content: UPDATED_README } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'readback-readme', name: 'read_file', input: { path: 'README.md' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: 'I updated README.md and checked the rendered section. No tests were run, and I did not commit or push.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ])
  let childDispatches = 0
  const engine = new ChatEngine({
    task: MAINTENANCE_TASK,
    projectRoot: root,
    executionScope: { kind: 'project', projectRoot: root },
    runId: `maintenance-integration-${randomUUID()}`,
    model: 'offline-maintenance-fixture',
    maxTurns: 10,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
    testChildLaneOverrides: {
      useDeterministicMock: false,
      actionResolver: async () => {
        childDispatches++
        return [{
          type: 'finish' as const,
          summary: 'This ask lane is read-only. The parent can add the README link and data-preservation note.',
          verification: [],
        }]
      },
    },
  })
  t.after(() => engine.closeAdmissionStore())
  const events = await collectStream(engine.submitMessageStream(MAINTENANCE_TASK))

  const snapshot = engine.getTurnRuntimeSnapshot()
  assert.equal(snapshot?.effectiveOperation, 'HYBRID', 'the scoped documentation edit intent must survive protected-object negatives')
  assert.equal(childDispatches, 2, JSON.stringify({
    events: events.filter(event => event.type === 'thought' || event.type === 'progress_recovery' || event.type === 'failed'),
    toolLog: (engine as unknown as { toolCallLog: Array<{ tool: string; target?: string; error?: string; detail?: string }> }).toolCallLog,
  }, null, 2))
  const feedback = (engine as unknown as { conversation: Array<{ name?: string; provenance?: string; authoritative?: boolean; content: string }> })
    .conversation.find(message => message.name === 'harness_feedback' && /same child delegation returned/i.test(message.content))
  assert.ok(feedback, 'repeated delegation must receive actionable no-progress guidance')
  assert.equal(feedback.provenance, 'controller')
  assert.equal(feedback.authoritative, false)

  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; target?: string; exit_code?: number; error?: string; mutation_paths?: string[] }>
  }).toolCallLog
  const childRows = log.filter(entry => entry.tool === 'sub_agent')
  assert.equal(childRows.length, 2)
  assert.ok(childRows.every(entry => entry.exit_code === 0), 'read-only child work should be delivered successfully')
  const write = log.find(entry => entry.tool === 'write_file' && entry.target === 'README.md')
  assert.ok(write, 'parent must use the ordinary governed write tool after child guidance')
  assert.equal(write.exit_code, 0, write.error)
  assert.deepEqual(write.mutation_paths?.map(path => resolve(path)), [join(root, 'README.md')])
  assert.equal(existsSync(join(root, 'README.md')), true)
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), UPDATED_README)
  assert.equal(readFileSync(join(root, 'docs/dashboard-refresh.md'), 'utf8'), SOURCE_DOC)

  const readback = log.find(entry => entry.tool === 'read_file' && entry.target === 'README.md' && entry.exit_code === 0 && log.indexOf(entry) > log.indexOf(write))
  assert.ok(readback, 'final content must be read back before delivery')
  const terminal = events.filter(event => event.type === 'done' || event.type === 'failed' || event.type === 'cancelled')
  assert.equal(terminal.length, 1)
  const end = terminal[0]
  if (end?.type !== 'done') assert.fail(`expected a user-facing terminal answer, received ${end?.type ?? 'no terminal event'}`)
  assert.notEqual(end.outcome, 'VERIFIED_COMPLETE', 'file creation/readback alone is not a verifier receipt')
  assert.match(end.answer, /README\.md/)
  assert.match(end.answer, /No authoritative verifier execution is recorded/i)
  assert.doesNotMatch(end.answer, /VERIFIED_COMPLETE|tests? passed/i)
})
