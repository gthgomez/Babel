import { createProviderRunner, ProviderEngine } from '../runners/providerEngine.js'
import { isProviderId } from '../runners/providerRegistry.js'
import type { ChatLlmRunner } from '../runners/base.js'
/** Provider selection and inference orchestration; accounting remains owner-scoped. */
import { OllamaApiRunner } from '../runners/ollamaApi.js'
import { OpenCodeGoApiRunner, type OpenCodeGoRunnerOptions } from '../runners/openCodeGoApi.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CommandCodeApiRunner } from '../runners/commandCodeApi.js'
import type { ProviderMessage, RunnerCallbacks } from '../runners/base.js'
import {
  assertLiveModelId,
  LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS,
  LIVE_OPENROUTER_MODEL_ID,
  resolveOpenRouterDeepSeekModelId,
  type ResolvedModelPolicy,
} from '../modelPolicy.js'
import { isChatOpenCodeGoRoute, isOfflineChatMode, resolveFallbackModelId } from './chatModelPolicy.js'
import type {
  ChatCallbacks,
  ChatEngineOptions,
  ChatEvent,
} from './chatEngineContracts.js'
import {
  chatActionTarget,
  chatActionToolName,
  type ChatToolAction,
  type ChatTurn,
} from './chatToolDefinitions.js'
import {
  buildProviderRetryCallbacks,
  type ChatUsageScope,
} from './chatEngineProviderAccounting.js'
import { isReadOnlyChat } from './chatReadOnly.js'
import { availableChatTools } from './chatToolAvailability.js'
import type { TaskOperation } from '../config/chatTaskClass.js'
import {
  nativeTurnFromStream,
  ProviderOutputTruncatedError,
} from './chatNativeTurn.js'
import { nativeToolUseToChatAction } from './chatEngineSupport.js'
import { terminalReasonFromFailureText, type TerminalReason } from './chatTerminalReason.js'
import { isAuthoritativeTaskAllowanceStopError, terminalReasonForAuthoritativeTaskAllowanceStopRequired } from './chatEngineProviderAccounting.js'
import { parseTextToolTurn } from './textToolParser.js'
import { parseChatTurnLenient } from './chatEngineHelpers.js'
import { type NextTurnToolPolicy } from './codingLoop/index.js'
import type { ChatEngineServices } from './chatEngineServices.js'
import type { FailoverDecision } from './providerCapabilities.js'

export type ChatProviderRunner =
  ChatLlmRunner
export type ChatProviderRetryContext = NonNullable<
  Parameters<typeof buildProviderRetryCallbacks>[1]
>
export type ChatProviderUsageEffects = {
  retryCallbacks: (context: ChatProviderRetryContext) => RunnerCallbacks
  settleUsage: (runner: ChatProviderRunner, scope: ChatUsageScope) => void
  getAbortController: () => AbortController
}
const TURN_TIMEOUT_MS = 120_000

/** Preserve explicit OpenRouter routes and the retained exact campaign contract. */
function isExactOpenRouterRoute(policy: ResolvedModelPolicy | undefined): boolean {
  return policy?.provider === 'openrouter' &&
    (policy.providerModelId === LIVE_OPENROUTER_MODEL_ID || policy.resolvedBackendKey?.startsWith('openrouter/') === true)
}

/** Resolve the selected route once; configuration failures never choose another provider. */
export function resolveChatDeliberationRunner(
  current: ChatProviderRunner | null,
  modelPolicy: ResolvedModelPolicy | undefined,
  goOptions?: OpenCodeGoRunnerOptions,
): ChatProviderRunner {
  if (!modelPolicy?.providerModelId || !isProviderId(modelPolicy.provider)) {
    if (current) return current // explicit embedding owns its injected runner
    throw new Error('SETUP_REQUIRED: No model connection is selected. Choose a provider and exact model with babel-agent setup.')
  }
  const provider = modelPolicy.provider
  const modelId = modelPolicy.providerModelId
  if (current instanceof ProviderEngine) {
    if (current.provider === provider && current.modelId === modelId &&
      (!goOptions?.budget || current.usesBudget(goOptions.budget))) return current
  } else if (current) {
    // Trusted embedding runners remain usable; exact vendor routes must still match.
    if (provider === 'opencode-go') {
      if (current instanceof OpenCodeGoApiRunner && current.getPinnedModelId() === modelId &&
        (!goOptions?.budget || current.usesBudget(goOptions.budget))) return current
    } else if (provider === 'command-code') {
      if (current instanceof CommandCodeApiRunner && current.getPinnedModelId() === modelId) return current
    } else if (isExactOpenRouterRoute(modelPolicy)) {
      if (current instanceof OpenRouterApiRunner && current.getPinnedModelId() === modelId) return current
    } else return current
  }
  if (provider === 'opencode-go' && !isChatOpenCodeGoRoute(modelPolicy)) {
    throw new Error('[LIVE_MODEL_POLICY] Chat requires the qualified explicit OpenCode Go route.')
  }
  return createProviderRunner({
    provider, modelId,
    ...(modelPolicy.authentication ? { authentication: modelPolicy.authentication } : {}),
    ...(modelPolicy.contextWindow ? { contextWindowTokens: modelPolicy.contextWindow } : {}),
    ...(modelPolicy.maxOutputTokens ? { sampling: { maxTokens: modelPolicy.maxOutputTokens } } : {}),
    ...goOptions,
    ...(modelPolicy.apiKeyEnvVar ? { apiKeyEnvVar: modelPolicy.apiKeyEnvVar } : {}),
    ...(modelPolicy.baseUrl ? { baseUrl: modelPolicy.baseUrl } : {}),
    requireExactModelId: isExactOpenRouterRoute(modelPolicy),
  })
}

/** An explicit fallback model stays on the selected provider and account. */
export function resolveChatFallbackRunner(
  current: ChatProviderRunner | null,
  options: Pick<ChatEngineOptions, 'providerRunner' | 'fallbackModel'>,
  modelPolicy: ResolvedModelPolicy | undefined,
): ChatProviderRunner | null {
  if (options.providerRunner) return options.providerRunner
  if (!options.fallbackModel || !modelPolicy || modelPolicy.provider === 'opencode-go') return null
  if (modelPolicy.provider === 'command-code' || isExactOpenRouterRoute(modelPolicy)) return null
  if (current) return current
  return resolveChatDeliberationRunner(null, { ...modelPolicy, providerModelId: options.fallbackModel })
}

/** Synthesis inherits the same selection and credentials as deliberation. */
export function resolveChatSynthesisRunner(
  current: ChatProviderRunner | null,
  modelPolicy: ResolvedModelPolicy | undefined,
  goOptions?: OpenCodeGoRunnerOptions,
): ChatProviderRunner {
  return resolveChatDeliberationRunner(current, modelPolicy, goOptions)
}

/** Synthesize an answer and settle usage against the captured submission owner. */
export async function synthesizeChatAnswer(
  runner: ChatProviderRunner,
  prompt: string,
  callbacks: ChatCallbacks,
  usageScope: ChatUsageScope,
  effects: ChatProviderUsageEffects,
  systemPrompt?: string,
): Promise<string> {
  const context: ChatProviderRetryContext = {
    deliveryMode: 'text',
    conversationState: prompt,
    executionStage: 'synthesis',
    ...(systemPrompt ? { systemPolicyPrompt: systemPrompt } : {}),
    usageScope,
    ...(usageScope.isOwnerCurrent
      ? { isOwnerCurrent: usageScope.isOwnerCurrent }
      : {}),
  }
  const runnerCallbacks: RunnerCallbacks = callbacks.onAnswerChunk
    ? {
        ...effects.retryCallbacks(context),
        onChunk: callbacks.onAnswerChunk,
        ...(callbacks.onThought ? { onThought: callbacks.onThought } : {}),
      }
    : effects.retryCallbacks(context)
  const answer = await executeChatRunnerWithTimeout(
    runner,
    prompt,
    runnerCallbacks,
    effects.getAbortController,
    systemPrompt,
  )
  effects.settleUsage(runner, usageScope)
  return answer
}

/** Execute with the existing turn deadline and retain cancellation-controller capture ordering. */
export async function executeChatRunnerWithTimeout(
  runner: ChatProviderRunner,
  prompt: string,
  callbacks: RunnerCallbacks | undefined,
  getAbortController: () => AbortController,
  systemPrompt?: string,
): Promise<string> {
  const execPromise = runner.executeRaw(
    prompt,
    callbacks,
    systemPrompt,
    getAbortController().signal,
  )

  // Capture the controller reference so the timeout always aborts the
  // controller that was active when this turn started, even if cancel()
  // replaces getAbortController() mid-flight (it creates a fresh one).
  const turnController = getAbortController()

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      turnController.abort()
      reject(
        new Error(
          `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s without a response`,
        ),
      )
    }, TURN_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([execPromise, timeoutPromise])
    return result
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    // Prevent unhandled rejection: if the timeout fires,
    // abortController.abort() causes execPromise to reject but
    // Promise.race has already settled with TimeoutError, leaving
    // an orphaned rejection.  Swallow it here.
    execPromise.catch(() => {})
  }
}

/** Choose the existing tool delivery profile for this provider and environment. */
export function shouldUseChatNativeTools(runner: ChatProviderRunner): boolean {
  // Ollama models generally don't support native OpenAI tool calling.
  // The legacy JSON path handles tool use via prompt formatting instead.
  if (runner instanceof OllamaApiRunner || (runner instanceof ProviderEngine && runner.provider === 'ollama')) return false
  return (
    process.env['BABEL_NATIVE_TOOLS'] !== 'disabled' &&
    typeof runner.executeWithToolsStream === 'function'
  )
}

/** Choose the existing tool delivery profile for this provider and environment. */
export function shouldUseChatTextTools(
  resolveRunner: () => ChatProviderRunner,
): boolean {
  if (process.env['BABEL_TOOL_PROFILE'] === 'legacy') return false
  if (process.env['BABEL_TOOL_PROFILE'] === 'text') return true
  if (process.env['BABEL_TOOL_PROFILE'] === 'native') return false
  const runner = resolveRunner()
  return runner instanceof OllamaApiRunner || (runner instanceof ProviderEngine && runner.provider === 'ollama')
}

export interface ChatDeliberationInput {
  runner: ChatProviderRunner
  promptOrMessages: string | ProviderMessage[]
  useNativeTools: boolean
  callbacks: ChatCallbacks
  hooks: { onStreamedChunks?: (text: string) => void }
  usageScope: ChatUsageScope
  tools: ChatEngineServices['tools']
  takeToolPolicy: () => NextTurnToolPolicy
  acceptedOperation?: TaskOperation | undefined
  executionScope?: import('./chatExecutionScope.js').ChatExecutionScope | undefined
  hostFallbackAllowed?: boolean | undefined
  requiredVerifierCommands?: readonly string[]
  systemPrompt: (mode: 'native' | 'text') => string
  useTextTools: () => boolean
  effects: ChatProviderUsageEffects
}
/** Run native, text-tool, or legacy deliberation with captured owner-scoped accounting. */
export async function deliberateChatTurn(
  input: ChatDeliberationInput,
): Promise<ChatTurn> {
  const {
    runner,
    promptOrMessages,
    useNativeTools,
    callbacks,
    hooks,
    usageScope,
    effects,
  } = input
  const executeWithTimeout = (
    activeRunner: ChatProviderRunner,
    prompt: string,
    retryCallbacks: RunnerCallbacks | undefined,
    systemPrompt?: string,
  ): Promise<string> =>
    executeChatRunnerWithTimeout(
      activeRunner,
      prompt,
      retryCallbacks,
      effects.getAbortController,
      systemPrompt,
    )
  if (useNativeTools && typeof runner.executeWithToolsStream === 'function') {
    const nextTools = input.takeToolPolicy()
    const restrictTools = input.executionScope?.kind!=='conversation'&&nextTools.restrict && !isReadOnlyChat() && input.acceptedOperation !== 'READ_ONLY'
    const toolDefs = availableChatTools(
      restrictTools
        ? input.tools.buildRestrictedDefinitions(
            nextTools.mode === 'full' ? 'act_or_verify' : nextTools.mode,
          )
        : input.tools.buildDefinitions(),
      { executionScope:input.executionScope,operation: input.acceptedOperation,
      requiredVerifiers: input.requiredVerifierCommands,
      hostFallbackAllowed: input.hostFallbackAllowed })
    const nativeActions: ChatToolAction[] = []
    let answerText = ''
    let nativeFinishReason: string | undefined
    const systemPrompt = input.systemPrompt('native')

    for await (const event of runner.executeWithToolsStream(
      Array.isArray(promptOrMessages)
        ? promptOrMessages
        : ([{ role: 'user', content: promptOrMessages }] as ProviderMessage[]),
      toolDefs,
      systemPrompt,
      effects.getAbortController().signal,
      restrictTools ? 'required' : 'auto',
      effects.retryCallbacks({
        deliveryMode: 'native',
        conversationState: promptOrMessages,
        systemPolicyPrompt: systemPrompt,
        toolSchema: toolDefs,
        executionStage: 'chat',
        usageScope,
      }),
    )) {
      switch (event.type) {
        case 'text_delta':
          answerText += event.text
          hooks.onStreamedChunks?.(answerText)
          callbacks.onAnswerChunk?.(event.text)
          break
        case 'thought_delta':
          callbacks.onThought?.(event.text)
          break
        case 'tool_use': {
          const action = nativeToolUseToChatAction(event.name, event.input)
          nativeActions.push(action)
          callbacks.onToolStart?.(
            chatActionToolName(action),
            chatActionTarget(action),
          )
          break
        }
        case 'error':
          throw new Error(event.message)
        case 'done':
          nativeFinishReason = event.finishReason
          break
        default: {
          const _exhaustive: never = event
          const unknownEvent: { type?: unknown } = _exhaustive
          throw new Error(`Unknown stream event: ${unknownEvent.type}`)
        }
      }
    }
    effects.settleUsage(runner, usageScope)
    return nativeTurnFromStream({
      answerText,
      actions: nativeActions,
      finishReason: nativeFinishReason,
    })
  }

  // ── Text-tools path — simplified format for small local models ──────────
  if (input.useTextTools()) {
    const systemPrompt = input.systemPrompt('text')
    const rawText = await executeWithTimeout(
      runner,
      promptOrMessages as string,
      effects.retryCallbacks({
        deliveryMode: 'text',
        conversationState: promptOrMessages,
        systemPolicyPrompt: systemPrompt,
        executionStage: 'chat',
        usageScope,
      }),
      systemPrompt,
    )
    const turn = parseTextToolTurn(rawText)
    effects.settleUsage(runner, usageScope)
    return turn
  }

  let streamedChunks = ''
  let looksLikeJson = false
  const deliberationCallbacks: RunnerCallbacks = {
    ...effects.retryCallbacks({
      deliveryMode: 'text',
      conversationState: promptOrMessages,
      executionStage: 'chat',
      usageScope,
    }),
    ...(callbacks.onThought || callbacks.onAnswerChunk
      ? {
          onChunk: (chunk: string) => {
            streamedChunks += chunk
            hooks.onStreamedChunks?.(streamedChunks)
            if (!looksLikeJson && streamedChunks.length >= 3) {
              const head = streamedChunks.trimStart()
              looksLikeJson =
                head.startsWith('{') ||
                head.startsWith('```json') ||
                head.startsWith('```')
            }
            if (!looksLikeJson && chunk.trim()) {
              callbacks.onAnswerChunk?.(chunk)
            }
          },
          ...(callbacks.onThought
            ? {
                onThought: (thought: string) => callbacks.onThought?.(thought),
              }
            : {}),
        }
      : {}),
  }

  const rawText = await executeWithTimeout(
    runner,
    promptOrMessages as string,
    deliberationCallbacks,
  )
  effects.settleUsage(runner, usageScope)
  return parseChatTurnLenient(rawText)
}

export interface ChatFallbackInput {
  err: any
  turn: number
  ownerGeneration: number | undefined
  options: Pick<ChatEngineOptions, 'model'>
  modelPolicy: ResolvedModelPolicy | undefined
  isSubmissionCurrent: (generation: number) => boolean
  cancelled: (error: unknown) => ChatEvent | null
  failed: (error: string, reason?: TerminalReason) => ChatEvent
  tryFailover: (modelId: string, error: unknown) => FailoverDecision | null
  resolveFallback: () => ChatProviderRunner | null
  installFailover: (
    runner: ChatProviderRunner,
    decision: FailoverDecision,
  ) => void
}
/** Settle fallback selection without allowing obsolete submissions to emit terminal evidence. */
export async function* resolveChatFallbackOrFail(
  input: ChatFallbackInput,
): AsyncGenerator<
  ChatEvent,
  ChatLlmRunner | null,
  undefined
> {
  const { err, turn, ownerGeneration } = input

  // R0-8: a superseded generator must not resolve a fallback or emit a
  // terminal for the task that now owns the engine.
  if (
    ownerGeneration !== undefined &&
    !input.isSubmissionCurrent(ownerGeneration)
  ) {
    return null
  }
  const cancelled = input.cancelled(err)
  if (cancelled) {
    yield cancelled
    return null
  }
  if (
    err instanceof ProviderOutputTruncatedError ||
    /finish_reason: length/i.test(err?.message ?? '')
  ) {
    yield input.failed(err?.message ?? String(err))
    return null
  }
  const errorMessage = err?.message ?? String(err)
  if (isAuthoritativeTaskAllowanceStopError(err)) {
    yield input.failed(errorMessage, terminalReasonForAuthoritativeTaskAllowanceStopRequired(err))
    return null
  }
  if (
    terminalReasonFromFailureText(errorMessage)?.code ===
    'unsupported_operation'
  ) {
    yield input.failed(errorMessage)
    return null
  }
  if (turn > 0) {
    yield input.failed(err.message)
    return null
  }
  if (process.env['BABEL_DESKTOP_PROVIDER']) {
    yield input.failed(`${err.message} [LIVE_MODEL_POLICY] The selected Desktop route failed; automatic provider or model substitution is disabled. Retry or choose another enabled model in Settings.`)
    return null
  }
  if (input.modelPolicy?.provider === 'command-code') {
    yield input.failed(`${err.message} [LIVE_MODEL_POLICY] exact Command Code route refuses provider substitution`)
    return null
  }
  if (isExactOpenRouterRoute(input.modelPolicy)) {
    const route = input.modelPolicy?.providerModelId === LIVE_OPENROUTER_MODEL_ID ? 'GLM' : 'configured OpenRouter'
    yield input.failed(`${err.message} [LIVE_MODEL_POLICY] exact ${route} route refuses provider substitution`)
    return null
  }
  if (input.modelPolicy?.provider === 'opencode-go') {
    yield input.failed(`${err.message} [LIVE_MODEL_POLICY] exact Go route refuses provider substitution`)
    return null
  }
  const fallback = input.resolveFallback()
  if (!fallback) {
    yield input.failed(err.message)
    return null
  }
  yield { type: 'thought', text: 'Using the explicitly configured fallback on the selected provider.' }
  return fallback
}
