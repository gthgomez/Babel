/**
 * Native path-list completion (stage 2): production ChatEngine admission, lease, runner,
 * and submitMessageStream. Transport is mocked only; no benchmark mode or injected runner.
 *
 * Lease: BABEL_AUTONOMY_LEASE_FILE points at host-owned JSON on disk — the same
 * production admission path documented in authority/lease.ts (not inline BABEL_AUTONOMY_LEASE).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
  TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
  TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
} from '../authority/trustedHostFilesystemPathList.js'
import {
  evaluateCriterionCompletionV1,
  type CriterionCompletionRequestV1,
} from '../authority/criterionCompletion.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import { refreshDryRunState } from '../localTools.js'
import { ChatEngine } from './chatEngine.js'
import type { ChatEvent } from './chatEngine.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID } from './pathListHostDeclaredClarification.js'
import { loadLiveSessionAuthorityStrict } from './liveSessionBridge.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from '../eval/campaign-qualified-routes.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

const QUALIFIED_OPENROUTER_POLICY: ResolvedModelPolicy = {
  policyPath: 'campaign-qualified-openrouter',
  family: 'openrouter',
  selectedTier: 'cheap',
  resolvedBackendKey: 'deepseek-v4-flash-openrouter',
  provider: 'openrouter',
  providerModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  expensive: false,
  enabled: true,
  experimental: false,
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
  'BABEL_BENCHMARK_MODE',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_AUTONOMY_LEASE_FILE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_DIRTY_TREE',
  'BABEL_RUNS_DIR',
  'BABEL_OFFLINE',
  'BABEL_CHAT_MAX_COST',
] as const

const PROVIDER_ROUTE = {
  model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  provider: 'openrouter' as const,
}

function git(projectRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(projectRoot, 'no-global-gitconfig'),
    },
  })
  assert.equal(result.status, 0, result.stderr?.toString() ?? 'git failed')
}

function hostClarificationBinding() {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const unresolved = meaning.sources.filter(source => source.status === 'unresolved')
  assert.equal(unresolved.length, 1)
  const source = unresolved[0]!
  return {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: source.criterion_id,
    task_request_digest: sha256Canonical(USER_REQUEST),
    meaning_input_digest: source.input_digest,
  }
}

function declarationPayload(binding: ReturnType<typeof hostClarificationBinding>) {
  return {
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request: USER_REQUEST,
    user_request_digest: sha256Canonical(USER_REQUEST),
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths',
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' },
    preserved_input_selectors: ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
    acceptance_clarification: binding,
  }
}

/** Host-issued lease file — canonical production admission, not an inline test bypass. */
function writeCanonicalProductionLeaseFile(projectRoot: string): string {
  const leasePath = join(projectRoot, 'host-admission', 'autonomy-lease.json')
  mkdirSync(dirname(leasePath), { recursive: true })
  const lease = {
    version: 2,
    leaseId: `native-path-list-${randomUUID()}`,
    scope: {
      repository: 'native-path-list-fixture',
      remote: 'origin',
      worktree: 'current',
      objective: USER_REQUEST,
    },
    allowedCapabilities: ['edit_task_files', 'inspect_repository'],
    branchPrefixes: ['feat/', 'fix/', 'test/'],
    constraints: {
      protectedBranches: ['main'],
      forcePush: false,
      remoteRefDelete: false,
      releasePublish: false,
      productionDeploy: false,
      repositoryAdmin: false,
      secretsAccess: false,
      billing: false,
      destructiveDb: false,
      scopeExpansion: false,
      securityPolicyChange: false,
      historyRewrite: false,
      allowedProtectedTargets: [],
    },
  }
  writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf8')
  return leasePath
}

function seedRepository(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'apps', 'web'), { recursive: true })
  mkdirSync(join(projectRoot, 'docs'), { recursive: true })
  mkdirSync(join(projectRoot, 'meta'), { recursive: true })
  writeFileSync(join(projectRoot, 'apps', 'web', 'entry.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(projectRoot, 'docs', 'notes.md'), '# notes\n', 'utf8')
  writeFileSync(join(projectRoot, 'meta', 'tree-index.md'), '- apps/web/stale.mjs\n', 'utf8')
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  git(projectRoot, ['add', 'apps', 'docs', 'meta'])
  git(projectRoot, ['commit', '-qm', 'path-list completion fixture'])
}

function treeIndexBody(): string {
  return '- apps/web/entry.mjs\n'
}

function sseLine(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

const FIXTURE_CRITIC_PASS = JSON.stringify({
  verdict: 'pass',
  confidence: 0.95,
  reasons: ['fixture critic pass'],
})

function fixtureJsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 12, cost: 0.00001 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

/** Mock transport only: OpenRouter SSE for streaming turns, JSON for critic/compaction auxiliaries. */
function installPathListFixtureFetch(
  openRouterSseForTurn: (turn: number) => string,
): { fetch: typeof globalThis.fetch; openRouterCalls: () => number } {
  let openRouterTurn = 0
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const rawBody = init?.body ? String(init.body) : ''
    let stream = false
    try {
      stream = (JSON.parse(rawBody) as { stream?: boolean }).stream === true
    } catch {
      stream = false
    }
    if (url.includes('openrouter.ai') || url.includes('chat/completions')) {
      if (stream) {
        openRouterTurn += 1
        return new Response(openRouterSseForTurn(openRouterTurn - 1), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return fixtureJsonCompletion(FIXTURE_CRITIC_PASS)
    }
    if (
      url.includes('anthropic.com') ||
      url.includes('deepinfra.com') ||
      url.includes('compaction')
    ) {
      return fixtureJsonCompletion('Compaction summary fixture.')
    }
    throw new Error(`unexpected fetch in path-list fixture: ${url}`)
  }
  return { fetch: fetchImpl, openRouterCalls: () => openRouterTurn }
}

function openRouterSseBody(turn: number): string {
  const model = CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID
  const usage = { prompt_tokens: 12, completion_tokens: 6, cost: 0.00001 }
  if (turn === 0) {
    const args = JSON.stringify({
      file_path: 'meta/tree-index.md',
      old_str: '- apps/web/stale.mjs\n',
      new_str: treeIndexBody(),
    })
    return (
      sseLine({
        model,
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-tree-index',
              type: 'function',
              function: { name: 'str_replace', arguments: args },
            }],
          },
        }],
      }) +
      sseLine({ model, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) +
      'data: [DONE]\n\n'
    )
  }
  const text = 'Updated meta/tree-index.md to list the scoped inventory under apps/.'
  return (
    sseLine({ model, choices: [{ delta: { content: text } }] }) +
    sseLine({ model, choices: [{ delta: {}, finish_reason: 'stop' }], usage }) +
    'data: [DONE]\n\n'
  )
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function terminalOutcome(events: ChatEvent[]): TerminalOutcome {
  const terminal = events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type))
  assert.equal(terminal.length, 1, `expected one terminal, saw ${terminal.map(e => e.type).join(',')}`)
  const event = terminal[0]!
  assert.ok(event.type === 'done' || event.type === 'failed')
  const outcome = event.type === 'done' ? event.outcome : event.outcome
  assert.ok(outcome !== undefined, 'terminal missing outcome')
  return outcome
}

function applyProductionPathListEnv(projectRoot: string, runsRoot: string): string {
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_DIRTY_TREE'] = '0'
  process.env['BABEL_RUNS_DIR'] = runsRoot
  assert.equal(process.env['BABEL_DIFF_CRITIC'], undefined)
  assert.equal(process.env['BABEL_COMPACTION'], undefined)
  assert.equal(process.env['BABEL_OFFLINE'], undefined)
  assert.equal(process.env['BABEL_CHAT_MAX_COST'], undefined)
  assert.equal(process.env['BABEL_BENCHMARK_MODE'], undefined)
  assert.equal(process.env['BABEL_BENCHMARK_AUTO_APPROVE'], undefined)
  assert.equal(process.env['BABEL_AUTONOMY_LEASE'], undefined)
  const leasePath = writeCanonicalProductionLeaseFile(projectRoot)
  process.env['BABEL_AUTONOMY_LEASE_FILE'] = leasePath
  refreshDryRunState()
  return leasePath
}

test('native path-list criterion: VERIFIED_COMPLETE via governed index update without shell verifier', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-native-path-list-completion-'))
  const runsRoot = join(projectRoot, 'runs')
  const savedFetch = globalThis.fetch
  const transport = installPathListFixtureFetch(openRouterSseBody)
  t.after(() => {
    globalThis.fetch = savedFetch
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyProductionPathListEnv(projectRoot, runsRoot)
  seedRepository(projectRoot)
  const binding = hostClarificationBinding()
  const declaration = declarationPayload(binding)
  const runId = `native-path-list-${randomUUID()}`

  const runner = new OpenRouterApiRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })

  globalThis.fetch = transport.fetch

  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot,
    operation: 'CHANGE',
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    maxTurns: 6,
    providerRunner: runner,
    providerPolicy: QUALIFIED_OPENROUTER_POLICY,
    trustedHostFilesystemPathListDeclaration: declaration,
  })

  assert.equal(
    engine.admitUserSubmission({ userInput: USER_REQUEST }, PROVIDER_ROUTE).status,
    'committed',
  )

  const pathListRow = engine.getTaskContract()!.acceptance.find(
    row => row.verification.verifier_id === HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
  )
  assert.ok(pathListRow, 'path-list criterion must be bound after admission')

  const events = await collectStream(engine.submitMessageStream(USER_REQUEST))
  const streamOutcome = terminalOutcome(events)

  const durable = loadLiveSessionAuthorityStrict(chatSessionDir(runId))
  const liveOutcome = engine.getLiveSession().terminal?.outcome

  const completionBox = engine as unknown as {
    criterionCompletion?: {
      currentRequest: () => CriterionCompletionRequestV1 | undefined
      refreshNativePathListEvidence(): void
      pathListVerificationRequest(): unknown
      evaluateOwnedPathListVerification(req: unknown): { verified: boolean; errors: string[] }
      nativePathListProofCompliant(): boolean
    }
    lastVerifierReceipt: { exit_code: number; command?: string } | null
    executedVerifierLedger: readonly unknown[]
    toolCallLog: Array<{ tool: string; error?: string }>
  }
  const evaluation = completionBox.criterionCompletion?.currentRequest()
    ? evaluateCriterionCompletionV1(completionBox.criterionCompletion.currentRequest())
    : undefined

  const indexBody = readFileSync(join(projectRoot, 'meta', 'tree-index.md'), 'utf8')

  assert.equal(indexBody, treeIndexBody(), 'governed write must update the path index document')
  assert.ok(transport.openRouterCalls() >= 2, `expected at least tool+completion transport calls, saw ${transport.openRouterCalls()}`)
  assert.ok(
    (engine as unknown as { parity: { sessionEvents: { events: Array<{ kind: string }> } } })
      .parity.sessionEvents.events.some(event => event.kind === 'mutation_batch'),
    'governed str_replace must emit mutation_batch session evidence',
  )

  assert.equal(streamOutcome, 'VERIFIED_COMPLETE', 'stream terminal must certify native path-list completion')
  assert.equal(liveOutcome, 'VERIFIED_COMPLETE', 'durable live session terminal must match stream')
  assert.equal(durable.taskContract.contract_hash, engine.getTaskContract()!.contract_hash)

  assert.ok(evaluation?.verified, `criterion graph must verify path-list row: ${evaluation?.errors?.join('; ')}`)
  assert.ok(
    evaluation?.satisfied_requirements.includes(pathListRow.id),
    `expected satisfied ${pathListRow.id}, got ${evaluation?.satisfied_requirements.join(',')}`,
  )

  assert.equal(completionBox.lastVerifierReceipt, null, 'shell verifier receipt must not stand in for native path-list proof')
  assert.equal(completionBox.executedVerifierLedger?.length ?? 0, 0)
  assert.ok(durable.filesystemPathListAdmission)
})

test('native path-list: shell verifier attempt stays blocked under safe_repo isolation', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-native-path-list-shell-'))
  const runsRoot = join(projectRoot, 'runs')
  const savedFetch = globalThis.fetch
  const transport = installPathListFixtureFetch(openRouterSseBody)
  t.after(() => {
    globalThis.fetch = savedFetch
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyProductionPathListEnv(projectRoot, runsRoot)
  seedRepository(projectRoot)
  const declaration = declarationPayload(hostClarificationBinding())
  const runId = `native-path-list-shell-${randomUUID()}`
  const runner = new OpenRouterApiRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  globalThis.fetch = installPathListFixtureFetch((turn) => {
    if (turn !== 0) return openRouterSseBody(turn)
    const model = CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID
    const usage = { prompt_tokens: 12, completion_tokens: 6, cost: 0.00001 }
    const args = JSON.stringify({ command: 'find apps -type f' })
    return (
      sseLine({
        model,
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-shell',
              type: 'function',
              function: { name: 'run_command', arguments: args },
            }],
          },
        }],
      }) +
      sseLine({ model, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) +
      'data: [DONE]\n\n'
    )
  }).fetch

  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot,
    operation: 'CHANGE',
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    maxTurns: 4,
    providerRunner: runner,
    providerPolicy: QUALIFIED_OPENROUTER_POLICY,
    trustedHostFilesystemPathListDeclaration: declaration,
  })
  engine.admitUserSubmission({ userInput: USER_REQUEST }, PROVIDER_ROUTE)
  const events = await collectStream(engine.submitMessageStream(USER_REQUEST))
  const outcome = terminalOutcome(events)
  const box = engine as unknown as {
    lastVerifierReceipt: unknown
    executedVerifierLedger: readonly unknown[]
    toolCallLog: Array<{ tool: string; error?: string }>
  }

  assert.notEqual(outcome, 'VERIFIED_COMPLETE')
  assert.equal(box.lastVerifierReceipt, null)
  assert.equal(box.executedVerifierLedger.length, 0)
  assert.ok(
    box.toolCallLog.some(entry => entry.tool === 'run_command' && entry.error),
    'shell must be policy-blocked without isolation',
  )
  assert.equal(
    readFileSync(join(projectRoot, 'meta', 'tree-index.md'), 'utf8'),
    '- apps/web/stale.mjs\n',
    'shell must not mutate the index when blocked',
  )
})

test('native path-list: copied verification request is not authoritative', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-native-path-list-forged-'))
  const runsRoot = join(projectRoot, 'runs')
  const savedFetch = globalThis.fetch
  const transport = installPathListFixtureFetch(openRouterSseBody)
  t.after(() => {
    globalThis.fetch = savedFetch
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyProductionPathListEnv(projectRoot, runsRoot)
  seedRepository(projectRoot)
  const declaration = declarationPayload(hostClarificationBinding())
  globalThis.fetch = transport.fetch
  const engine = new ChatEngine({
    runId: `native-path-list-forged-${randomUUID()}`,
    task: USER_REQUEST,
    projectRoot,
    operation: 'CHANGE',
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    maxTurns: 6,
    providerRunner: new OpenRouterApiRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
      explicitCredential: 'synthetic-fixture',
      env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
    }),
    providerPolicy: QUALIFIED_OPENROUTER_POLICY,
    trustedHostFilesystemPathListDeclaration: declaration,
  })
  engine.admitUserSubmission({ userInput: USER_REQUEST }, PROVIDER_ROUTE)
  await collectStream(engine.submitMessageStream(USER_REQUEST))

  const service = (engine as unknown as {
    criterionCompletion?: {
      pathListVerificationRequest(): unknown
      evaluateOwnedPathListVerification(req: unknown): { verified: boolean; errors: string[] }
    }
  }).criterionCompletion
  const owned = service?.pathListVerificationRequest()
  assert.ok(owned)
  const forged = Object.freeze({ schema_version: 1, kind: 'path-list-verification:v1' })
  assert.deepEqual(service?.evaluateOwnedPathListVerification(forged), {
    verified: false,
    errors: ['PATH_LIST_REQUEST_UNTRUSTED'],
  })
  assert.equal(service?.evaluateOwnedPathListVerification(owned)?.verified, true)
})
