/** Capture synthetic requests at the real Chat runner boundary; never dispatch a model. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { getEncoding } from 'js-tiktoken'

const argv = process.argv.slice(2)
const arg = (name) => argv[argv.indexOf(name) + 1]
const sourceRoot = argv.includes('--source-root') ? resolve(arg('--source-root')) : resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = argv.includes('--output') ? resolve(arg('--output')) : null
if (!output) throw new Error('Usage: capture_coding_loop.mjs --output <file> [--source-root <checkout>]')

const fixture = mkdtempSync(join(tmpdir(), 'babel-loop-snapshot-'))
const source = join(fixture, 'project')
mkdirSync(source)
// The source contract is public repository content, copied into an otherwise
// synthetic project. No ambient user context, credentials or project data.
writeFileSync(join(source, 'AGENTS.md'), readFileSync(join(sourceRoot, 'AGENTS.md'), 'utf8'))
writeFileSync(join(source, 'fixture.ts'), 'export const answer = 42\n')
writeFileSync(join(source, 'context.md'), 'Prefer concise explanations.\n')
const env = {
  BABEL_ROOT: sourceRoot,
  BABEL_CONFIG_DIR: join(fixture, 'config'),
  BABEL_STATE_DIR: join(fixture, 'state'),
  BABEL_CACHE_DIR: join(fixture, 'cache'),
  BABEL_RUNS_DIR: join(fixture, 'runs'),
  BABEL_USER_CONTEXT: join(source, 'context.md'),
  BABEL_PROJECT_ROOT: source,
  BABEL_COMPACTION: 'off',
  BABEL_MEMORY_WRITEBACK: '0',
  BABEL_CHAT_MAX_COST: 'unlimited', // scripted provider has no price or network
  BABEL_LITE_OFFLINE: '0', // exercise the real child loop through a stubbed transport
  BABEL_DISABLE_DOTENV: '1',
  BABEL_TESTS_ALLOW_INFERENCE: '0',
  // Constructor-only fixtures. Request methods are replaced before child
  // construction and the no-ambient-inference guard remains installed.
  OPENROUTER_API_KEY: 'fixture-only-not-a-credential',
  DEEPSEEK_API_KEY: 'fixture-only-not-a-credential',
  DEEPINFRA_API_KEY: 'fixture-only-not-a-credential',
}
const beforeEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
Object.assign(process.env, env)
const mod = (path) => import(pathToFileURL(join(sourceRoot, 'babel-cli/src', path)).href)
await import(pathToFileURL(join(sourceRoot, 'babel-cli/src/testinfra/register-no-ambient-inference.mjs')).href)
const { ChatEngine } = await mod('agent/chatEngine.ts')
const { runChatEngineOnce, compileChatStackForRun } = await mod('interactive/execution/chatCore.ts')
const { analyzeTaskShape, resolveChatTaskClass, getChatTaskTune } = await mod('config/chatTaskClass.ts')
const { mapProviderMessagesToWire } = await mod('runners/providerMessages.ts')
const { buildChatToolDefinitions } = await mod('agent/chatToolDefinitions.ts')
const { TEXT_TOOL_NAMES } = await mod('agent/textToolParser.ts')
const { runReadOnlyAgentLoop } = await mod('agent/lanes/readOnlyAgentLoop.ts')
const { DeepInfraApiRunner } = await mod('runners/deepInfraApi.ts')
const { DeepSeekApiRunner } = await mod('runners/deepSeekApi.ts')
const encoding = getEncoding('cl100k_base')

const normalize = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string'
  ? item.split(sourceRoot).join('<BABEL_SOURCE>').split(fixture).join('<FIXTURE>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<TIME>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<ID>')
  : item))
const count = (text) => ({ chars: text.length, referenceTokens: encoding.encode(text).length })
const captures = []
const target = { targetRoot: source, workspaceRoot: null, project: null, source: 'cwd', cwd: source }
let activeCapture = null

function attachRunner(engine, protocol) {
  const record = (request) => { if (activeCapture && !activeCapture.request) activeCapture.request = normalize(request) }
  const runner = {
    executeWithToolsStream: async function* (messages, tools, systemPrompt, _signal, toolChoice) {
      record({ messages: mapProviderMessagesToWire(messages, '', systemPrompt), tools, toolChoice })
      yield { type: 'text_delta', text: 'Snapshot fixture stopped after recording the request.' }
      yield { type: 'done', finishReason: 'stop' }
    },
    executeRaw: async (prompt, _callbacks, systemPrompt) => {
      record({ systemPrompt, prompt, tools: [] })
      return 'Snapshot fixture stopped after recording the request.'
    },
    executeRawStream: async function* (prompt, systemPrompt) {
      record({ systemPrompt, prompt, tools: [] })
      yield 'Snapshot fixture stopped after recording the request.'
    },
    execute: async (prompt) => {
      record({ prompt, tools: [] })
      return { type: 'completion', answer: 'Snapshot fixture stopped after recording the request.' }
    },
    getLastInvocationMetadata: () => null,
  }
  engine.deliberationRunner = runner
  engine.synthesisRunner = runner
  engine.shouldUseNativeTools = () => protocol === 'native'
  engine.shouldUseTextTools = () => protocol === 'text'
  return engine
}

const scenarios = [
  { id: 'trivial-read-only', task: 'What is the value exported by fixture.ts?' },
  { id: 'deep-audit', task: 'Review the architecture in depth. Inspect the data flow without editing anything.' },
  { id: 'one-file-fix', task: 'Fix null handling in the single function in fixture.ts.' },
  { id: 'multi-file-swe', task: 'Fix the race condition across the modules and failing test suite.' },
  { id: 'investigate-then-fix', task: 'Investigate the failure then fix the parser.' },
  { id: 'explicit-no-edit', task: 'Do not modify anything. Inspect the code and explain the issue.' },
  { id: 'governance', task: 'Audit the prompt injection and secret exfiltration boundary; do not edit files.' },
  { id: 'verifier-command', task: 'Fix the parser. Run `npm test` to verify the result.' },
  { id: 'reused-tui', task: 'Explain fixture.ts after the previous task.', reused: true, runtimeMode: 'tui' },
  { id: 'native-tools', task: 'Fix the single function in fixture.ts.', protocol: 'native' },
  { id: 'text-tools', task: 'Fix the single function in fixture.ts.', protocol: 'text' },
  { id: 'legacy-json', task: 'Fix the single function in fixture.ts.', protocol: 'legacy' },
  { id: 'text-read-only', task: 'Do not modify anything. Explain fixture.ts.', protocol: 'text' },
  { id: 'legacy-read-only', task: 'Do not modify anything. Explain fixture.ts.', protocol: 'legacy' },
]

try {
  let priorEngine
  for (const scenario of scenarios) {
    const protocol = scenario.protocol ?? 'native'
    const taskClass = resolveChatTaskClass({ taskText: scenario.task, autoClassify: true })
    const stack = compileChatStackForRun({ projectRoot: source, task: scenario.task, taskClass })
    const snapshot = {
      id: scenario.id,
      protocol,
      runtimeMode: scenario.runtimeMode ?? 'headless',
      task: scenario.task,
      taskClass,
      runtimeCapabilityClass: analyzeTaskShape(scenario.task).operation,
      verifierRequirement: getChatTaskTune(taskClass).verificationPolicy,
      stack: normalize(stack),
      sourcesIncluded: stack.content_disposition.filter(d => d.status !== 'omitted').map(d => d.id),
      sourcesOmitted: stack.content_disposition.filter(d => d.status === 'omitted').map(d => d.id),
      optionalSourcesOmittedByProtocol: protocol === 'text' ? ['caller:preflight', 'context:repo-map'] : [],
      ordinaryChatExcludedSources: ['CLAUDE.md', 'Claude.md', 'BABEL.md', 'PROJECT_CONTEXT.md', '.agents/skills (unless explicitly loaded)', 'prompt_catalog stages/OS/domain overlays (Plan/Deep only)'],
      request: null,
    }
    activeCapture = snapshot
    const factory = options => {
      priorEngine = attachRunner(new ChatEngine({ ...options, maxTurns: 1 }), protocol)
      return priorEngine
    }
    if (scenario.reused && priorEngine) attachRunner(priorEngine, protocol)
    try {
      await runChatEngineOnce({
        task: scenario.task, target,
        appendSystemPrompt: 'CALLER_CONTRACT: preserve the authorized project scope.',
        preflightContext: 'PREFLIGHT_FIXTURE: fixture.ts exists.',
        engineFactory: factory,
        ...(scenario.reused && priorEngine ? { engine: priorEngine } : {}),
        runtimeMode: snapshot.runtimeMode,
        useStreaming: true,
      })
    } catch (error) {
      snapshot.captureNote = String(error.message).split(fixture).join('<FIXTURE>')
    }
    if (!snapshot.request) throw new Error(`No production runner request captured: ${scenario.id}: ${snapshot.captureNote ?? 'no terminal error'}`)
    const request = snapshot.request
    const instructionText = request.messages
      ? request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n')
      : request.systemPrompt ?? request.prompt ?? ''
    const toolText = JSON.stringify(request.tools ?? [])
    const manual = instructionText.match(/## (?:Tool Definitions|Available Tools)[\s\S]*?(?=\n## |$)/)?.[0]
      ?? instructionText.match(/## How to use tools[\s\S]*?(?=\n## |$)/)?.[0]
      ?? (protocol === 'text' ? instructionText.split('## Project Context')[0] : '')
    const nativeNames = (request.tools ?? []).map(tool => tool.function.name)
    const manualNames = [...new Set([
      ...[...manual.matchAll(/^- `([^`]+)`\(/gm)].map(match => match[1]),
      ...[...manual.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]),
      ...[...manual.matchAll(/^- ([a-z_]+):/gm)].map(match => match[1]),
      ...[...manual.matchAll(/\[TOOL:([a-z_]+)\]/g)].map(match => match[1]),
    ])].filter(name => name !== 'tool_name')
    snapshot.toolNames = protocol === 'native' ? nativeNames : manualNames
    snapshot.parserAcceptedToolNames = protocol === 'text' ? [...TEXT_TOOL_NAMES] : null
    snapshot.toolDocumentation = manual
    snapshot.supplementalUserMessages = request.messages?.filter(message => message.role === 'user')
      ?? [{ role: 'user', content: request.prompt ?? '' }]
    const deliveredSources = ['chat:core-and-protocol', ...snapshot.sourcesIncluded]
    if (instructionText.includes('CALLER_CONTRACT:')) deliveredSources.push('caller:append')
    if (instructionText.includes('PREFLIGHT_FIXTURE:')) deliveredSources.push('caller:preflight')
    if (instructionText.includes('Task Verifier') || instructionText.includes('Task verifier command:')) deliveredSources.push('task:verifier-command')
    if (priorEngine?.repoMapCache && instructionText.includes(normalize(priorEngine.repoMapCache))) deliveredSources.push('context:repo-map')
    snapshot.deliveredInstructionSources = deliveredSources
    snapshot.metrics = {
      instruction: count(instructionText),
      toolSchema: count(toolText),
      toolManual: count(manual),
      request: count(JSON.stringify(request)),
      toolCount: snapshot.toolNames.length,
      nativeSchemaCount: nativeNames.length,
      instructionSources: deliveredSources.length,
      duplicatedWorkflowHeadings: ['Core Principles', 'How You Work', 'Recommended Workflow'].filter(h => instructionText.includes(h)).length,
    }
    captures.push(snapshot)
  }
  // Capture after the child waterfall and provider have selected their actual
  // system context, before transport. No credentials or HTTP headers are read.
  // OpenRouter inherits the DeepInfra request implementation.
  let childRequest = null
  let childResult
  const childPrototypes = [DeepInfraApiRunner.prototype, DeepSeekApiRunner.prototype]
  const requestMethods = childPrototypes.map(prototype => prototype._executeRequest)
  try {
    for (const prototype of childPrototypes) prototype._executeRequest = async function (prompt, _callbacks, systemPrompt) {
      childRequest ??= normalize({ messages: [
        { role: 'system', content: systemPrompt }, { role: 'user', content: prompt },
      ], tools: [], responseProtocol: 'AgentActionsEnvelopeSchema' })
      return { text: JSON.stringify({ actions: [{ type: 'finish', summary: 'Captured child request.', verification: [] }] }),
        startedAt: Date.now(), streamState: { ttftMs: null, generationMs: null, usage: null,
          observedModelId: null, upstreamProvider: null, partialModelOutput: true,
          outputReceipt: 'synthetic_snapshot', sawDone: true } }
    }
    childResult = await runReadOnlyAgentLoop({ verb: 'ask',
      task: 'Inspect fixture.ts and report the exported constant.', projectRoot: source,
      seedPaths: ['fixture.ts'], maxRounds: 1,
      additionalInstructions: 'Return concrete file evidence; do not edit.',
      toolContext: { agentId: 'snapshot-child', runId: 'snapshot-child', babelRoot: sourceRoot, projectRoot: source },
    })
  } finally {
    for (let i = 0; i < childPrototypes.length; i++) childPrototypes[i]._executeRequest = requestMethods[i]
  }
  if (!childRequest) throw new Error(`No production child provider request captured: ${childResult?.blockedReason ?? childResult?.providerError ?? 'no provider round'}`)
  const childText = childRequest.messages.map(message => message.content).join('\n\n')
  captures.push({
    id: 'subagent-invocation', protocol: 'child-actions',
    recipient: 'read-only child',
    captureLayer: 'real child discovery loop and waterfall; provider transport stub after default system selection',
    request: childRequest, runtimeCapabilityClass: 'READ_ONLY', taskClass: 'ask child', verifierRequirement: 'none',
    sourcesIncluded: ['child:read-only-discovery', 'parent:additional-instructions', 'provider:structured-system'],
    sourcesOmitted: ['chat:root-contract', 'chat:repository-stack'],
    supplementalUserMessages: childRequest.messages.filter(message => message.role === 'user'),
    toolNames: ['read_file', 'list_dir', 'search', 'grep', 'glob', 'finish', 'ask_approval'],
    toolDocumentation: childRequest.messages.find(message => message.role === 'user').content,
    metrics: { instruction: count(childText), toolCount: 7, nativeSchemaCount: 0, instructionSources: 3 },
  })
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({
    schemaVersion: 2,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
    trackedDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: sourceRoot })).digest('hex'),
    captureLayer: 'real ChatEngine preparation and runner invocation; scripted provider, no network or model spend',
    referenceTokenizer: 'cl100k_base (comparison only; not billed provider tokens)',
    terminalNote: 'Snapshot tasks intentionally stop after request capture; terminal results are not task-success evaluations.',
    nativeRegistryToolNames: buildChatToolDefinitions().map(t => t.function.name),
    scenarios: captures,
  }, null, 2) + '\n')
  console.log(JSON.stringify(captures.map(s => ({ id: s.id, ...s.metrics })), null, 2))
} finally {
  for (const [key, value] of Object.entries(beforeEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fixture, { recursive: true, force: true })
}
