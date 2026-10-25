/**
 * Native path-list completion (stage 2): real ChatEngine + governed edits + deterministic provider only.
 * Not a benchmark/scripted-admission proof — production authority paths with transport substituted.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { ToolStreamEvent } from '../runners/base.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import { refreshDryRunState } from '../localTools.js'
import { ChatEngine } from './chatEngine.js'
import type { ChatEvent } from './chatEngine.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID } from './pathListHostDeclaredClarification.js'
import { loadLiveSessionAuthorityStrict } from './liveSessionBridge.js'
import { chatSessionDir } from '../cli/runsLayout.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'native-path-list-completion-fixture',
  family: 'native-path-list-completion-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'native-path-list-completion-fixture',
  provider: 'deepinfra',
  providerModelId: 'native-path-list-completion-fixture-model',
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
  'BABEL_BENCHMARK_MODE',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_DIRTY_TREE',
  'BABEL_RUNS_DIR',
] as const

const PROVIDER_ROUTE = {
  model: FIXTURE_POLICY.providerModelId,
  provider: FIXTURE_POLICY.provider,
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

function buildRunner(): {
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
        if (turn === 0) {
          turn++
          yield {
            type: 'tool_use',
            id: 'write-tree-index',
            name: 'str_replace',
            input: {
              file_path: 'meta/tree-index.md',
              old_str: '- apps/web/stale.mjs\n',
              new_str: treeIndexBody(),
            },
          }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        turn++
        yield {
          type: 'text_delta',
          text: 'Updated meta/tree-index.md to list the scoped inventory under apps/.',
        }
        yield { type: 'done', finishReason: 'stop' }
      },
      async execute() {
        return {
          type: 'completion',
          answer: 'Updated meta/tree-index.md to list the scoped inventory under apps/.',
        }
      },
      async executeRaw() {
        return 'Updated meta/tree-index.md to list the scoped inventory under apps/.'
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

test('native path-list criterion: VERIFIED_COMPLETE via governed index update without shell verifier', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-native-path-list-completion-'))
  const runsRoot = join(projectRoot, 'runs')
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_DIRTY_TREE'] = '0'
  process.env['BABEL_RUNS_DIR'] = runsRoot
  assert.equal(process.env['BABEL_BENCHMARK_AUTO_APPROVE'], undefined)
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: `native-path-list-${randomUUID()}`,
    scope: { repository: 'native-path-list-fixture', objective: USER_REQUEST },
    allowedCapabilities: ['edit_task_files', 'inspect_repository'],
  })
  refreshDryRunState()

  seedRepository(projectRoot)
  const binding = hostClarificationBinding()
  const declaration = declarationPayload(binding)
  const { runner } = buildRunner()
  const runId = `native-path-list-${randomUUID()}`

  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 6,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
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
    }
    lastVerifierReceipt: { exit_code: number; command?: string } | null
    executedVerifierLedger: readonly unknown[]
  }
  const evaluation = completionBox.criterionCompletion?.currentRequest()
    ? evaluateCriterionCompletionV1(completionBox.criterionCompletion.currentRequest())
    : undefined

  assert.equal(
    readFileSync(join(projectRoot, 'meta', 'tree-index.md'), 'utf8'),
    treeIndexBody(),
    'governed write must update the path index document',
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
