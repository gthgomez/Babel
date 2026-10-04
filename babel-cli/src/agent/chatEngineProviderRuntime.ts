/** Provider selection and inference orchestration; accounting remains owner-scoped. */
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js'
import { OllamaApiRunner } from '../runners/ollamaApi.js'
import { OpenCodeApiRunner } from '../runners/openCodeApi.js'
import { OpenCodeGoApiRunner, type OpenCodeGoRunnerOptions } from '../runners/openCodeGoApi.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
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
import { filterReadOnlyChatTools, filterReadOnlyTaskTools, isReadOnlyChat } from './chatReadOnly.js'
import type { TaskOperation } from '../config/chatTaskClass.js'
import {
  nativeTurnFromStream,
  ProviderOutputTruncatedError,
} from './chatNativeTurn.js'
import { nativeToolUseToChatAction } from './chatEngineSupport.js'
import { terminalReasonFromFailureText } from './chatTerminalReason.js'
import { parseTextToolTurn } from './textToolParser.js'
import { parseChatTurnLenient } from './chatEngineHelpers.js'
import { type NextTurnToolPolicy } from './codingLoop/index.js'
import type { ChatEngineServices } from './chatEngineServices.js'
import type { FailoverDecision } from './providerCapabilities.js'

export type ChatProviderRunner =
  | DeepInfraApiRunner
  | DeepSeekApiRunner
  | OllamaApiRunner
  | OpenRouterApiRunner
export type ChatProviderRetryContext = NonNullable<
  Parameters<typeof buildProviderRetryCallbacks>[1]
>
export type ChatProviderUsageEffects = {
  retryCallbacks: (context: ChatProviderRetryContext) => RunnerCallbacks
  settleUsage: (runner: ChatProviderRunner, scope: ChatUsageScope) => void
  getAbortController: () => AbortController
}
const TURN_TIMEOUT_MS = 120_000

/** Resolve the configured deliberation runner while preserving provider fallback diagnostics. */
export function resolveChatDeliberationRunner(
  current: ChatProviderRunner | null,
  modelPolicy: ResolvedModelPolicy | undefined,
  goOptions?: OpenCodeGoRunnerOptions,
): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner {
  let runner = current

  if (modelPolicy?.provider === 'opencode-go' && goOptions?.budget &&
    (!(runner instanceof OpenCodeGoApiRunner) || !runner.usesBudget(goOptions.budget) ||
      runner.getPinnedModelId() !== modelPolicy.providerModelId)) runner = null

  if (!runner) {
    const provider = modelPolicy?.provider
    const modelId = modelPolicy?.providerModelId
    if (provider === 'ollama' && modelId) {
      try {
        runner = new OllamaApiRunner(modelId)
      } catch (err) {
        throw new Error(
          `Cannot start chat: Ollama runner failed to initialize.\n` +
            `  ${err instanceof Error ? err.message : String(err)}\n` +
            `  Is Ollama running? Start it with: ollama serve\n` +
            `  Then pull a model: ollama pull gemma3:4b`,
        )
      }
    } else if (provider === 'deepseek' && modelId) {
      if (!isOfflineChatMode()) {
        throw new Error(
          '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
        )
      }
      try {
        runner = new DeepSeekApiRunner(modelId)
      } catch (err) {
        if (!isOfflineChatMode()) {
          throw new Error(
            'Cannot start live chat: DeepSeek runner is unavailable. ' +
              'Set DEEPSEEK_API_KEY in your environment.',
          )
        }
        // Fall back to DeepSeek Flash if v4 Pro is unavailable
        try {
          runner = new DeepSeekApiRunner('deepseek-v4-flash')
        } catch (fallbackErr) {
          throw new Error(
            `Cannot start chat: DeepSeek runner failed to initialize.\n` +
              `  v4 Pro: ${err instanceof Error ? err.message : String(err)}\n` +
              `  v4 Flash: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n` +
              `  Set DEEPSEEK_API_KEY in your environment.\n` +
              `  Use /model to see available providers.`,
          )
        }
      }
    } else if (provider === 'opencode-go') {
      if (!isChatOpenCodeGoRoute(modelPolicy)) {
        throw new Error('[LIVE_MODEL_POLICY] Chat requires the qualified explicit OpenCode Go route.')
      }
      runner = new OpenCodeGoApiRunner(modelId!, {}, goOptions)
    } else if (provider === 'opencode' && modelId) {
      // OpenCode Zen (e.g. ox-alpha-free): explicit backend-key opt-in.
      try {
        runner = new OpenCodeApiRunner(modelId)
      } catch (err) {
        throw new Error(
          `Cannot start chat: OpenCode runner failed to initialize.\n` +
            `  ${err instanceof Error ? err.message : String(err)}\n` +
            `  Set OPENCODE_API_KEY in your environment.\n` +
            `  Use /model to see available providers.`,
        )
      }
    } else if (provider === 'openrouter' && modelId) {
      try {
        runner = new OpenRouterApiRunner(modelId)
      } catch (err) {
        throw new Error(
          `Cannot start chat: OpenRouter runner failed to initialize.\n` +
            `  ${err instanceof Error ? err.message : String(err)}\n` +
            `  Set OPENROUTER_API_KEY in your environment.\n` +
            `  Use /model to see available models.`,
        )
      }
    } else if (modelId) {
      const offline = isOfflineChatMode()
      if (!offline) {
        assertLiveModelId(modelId, 'live chat')
        const routedModel = resolveOpenRouterDeepSeekModelId(modelId)
        if (!routedModel) {
          throw new Error(
            '[LIVE_MODEL_POLICY] Live chat requires an OpenRouter-approved model route.',
          )
        }
        runner = new OpenRouterApiRunner(routedModel)
        return runner
      }
      try {
        runner = offline
          ? new DeepInfraApiRunner(modelId)
          : new DeepSeekApiRunner(modelId)
      } catch (err) {
        throw new Error(
          `Cannot start chat: ${offline ? 'DeepInfra' : 'DeepSeek'} runner failed to initialize.\n  ${err instanceof Error ? err.message : String(err)}\n  Set ${offline ? 'DEEPINFRA_API_KEY' : 'DEEPSEEK_API_KEY'} in your environment.\n  Use /model to see available providers.`,
        )
      }
    } else {
      // No model configured — resolve from policy default tier.
      const fallbackId = resolveFallbackModelId()
      try {
        runner = isOfflineChatMode()
          ? new DeepSeekApiRunner(fallbackId)
          : new OpenRouterApiRunner(LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0])
      } catch {
        if (!isOfflineChatMode()) {
          throw new Error(
            'Cannot start live chat: OpenRouter DeepSeek runner is unavailable. Set OPENROUTER_API_KEY in your environment.',
          )
        }
        try {
          runner = new DeepInfraApiRunner(fallbackId)
        } catch (err) {
          throw new Error(
            `Cannot start chat: no LLM runner is available.\n` +
              `  ${err instanceof Error ? err.message : String(err)}\n` +
              `  Set DEEPSEEK_API_KEY in your environment.\n` +
              `  Use /model to see available providers.`,
          )
        }
      }
    }
  }
  return runner
}

/** Resolve an allowed fallback without crossing exact live-provider route constraints. */
export function resolveChatFallbackRunner(
  current: ChatProviderRunner | null,
  options: Pick<ChatEngineOptions, 'providerRunner' | 'fallbackModel'>,
  modelPolicy: ResolvedModelPolicy | undefined,
): ChatProviderRunner | null {
  let runner = current

  if (options.providerRunner) return options.providerRunner
  if (modelPolicy?.provider === 'opencode-go') return null
  if (
    !isOfflineChatMode() &&
    modelPolicy?.provider === 'openrouter' &&
    modelPolicy.providerModelId
  ) {
    if (!runner) {
      try {
        // Campaign invariant: an exact GLM run may retry the same model, but
        // may not silently fail over to a different provider/model.
        runner = new OpenRouterApiRunner(modelPolicy.providerModelId)
      } catch {
        return null
      }
    }
    return runner
  }
  if (!options.fallbackModel) return null
  if (!isOfflineChatMode()) {
    assertLiveModelId(options.fallbackModel, 'live chat fallback')
    const routedModel = resolveOpenRouterDeepSeekModelId(options.fallbackModel)
    if (!routedModel) {
      return null
    }
    if (!runner) {
      try {
        runner = new OpenRouterApiRunner(routedModel)
      } catch {
        return null
      }
    }
    return runner
  }
  if (!runner) {
    try {
      runner = new OllamaApiRunner(options.fallbackModel)
    } catch {
      try {
        runner = new DeepInfraApiRunner(options.fallbackModel)
      } catch {
        try {
          runner = new DeepSeekApiRunner(options.fallbackModel)
        } catch {
          return null
        }
      }
    }
  }
  return runner
}

/** Resolve the synthesis route independently from deliberation with the existing offline fallbacks. */
export function resolveChatSynthesisRunner(
  current: ChatProviderRunner | null,
  modelPolicy: ResolvedModelPolicy | undefined,
  goOptions?: OpenCodeGoRunnerOptions,
): ChatProviderRunner {
  let runner = current
  if (modelPolicy?.provider === 'opencode-go' && goOptions?.budget &&
    (!(runner instanceof OpenCodeGoApiRunner) || !runner.usesBudget(goOptions.budget) ||
      runner.getPinnedModelId() !== modelPolicy.providerModelId)) runner = null
  if (!runner) {
    const provider = modelPolicy?.provider
    const modelId = modelPolicy?.providerModelId
    const offline = isOfflineChatMode()
    if (provider === 'ollama' && modelId) {
      if (!offline)
        throw new Error(
          '[LIVE_MODEL_POLICY] Ollama is not a valid live chat provider.',
        )
      try {
        runner = new OllamaApiRunner(modelId)
      } catch {
        runner = new DeepInfraApiRunner(resolveFallbackModelId())
      }
    } else if (provider === 'deepseek' && modelId) {
      if (!offline) {
        throw new Error(
          '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
        )
      }
      try {
        runner = new DeepSeekApiRunner(modelId)
      } catch {
        if (!offline)
          throw new Error(
            'Cannot start live chat synthesis: DeepSeek runner is unavailable. Set DEEPSEEK_API_KEY in your environment.',
          )
        runner = new DeepInfraApiRunner(resolveFallbackModelId())
      }
    } else if (provider === 'opencode-go') {
      if (!isChatOpenCodeGoRoute(modelPolicy)) {
        throw new Error('[LIVE_MODEL_POLICY] Chat requires the qualified explicit OpenCode Go route.')
      }
      runner = new OpenCodeGoApiRunner(modelId!, {}, goOptions)
    } else if (provider === 'opencode' && modelId) {
      runner = new OpenCodeApiRunner(modelId)
    } else if (provider === 'openrouter' && modelId) {
      try {
        runner = new OpenRouterApiRunner(modelId)
      } catch {
        throw new Error(
          'Cannot start live chat synthesis: OpenRouter runner is unavailable. Set OPENROUTER_API_KEY in your environment.',
        )
      }
    } else if (modelId) {
      if (!offline) {
        assertLiveModelId(modelId, 'live chat synthesis')
        const routedModel = resolveOpenRouterDeepSeekModelId(modelId)
        if (!routedModel) {
          throw new Error(
            '[LIVE_MODEL_POLICY] Live chat synthesis requires an OpenRouter-approved model route.',
          )
        }
        runner = new OpenRouterApiRunner(routedModel)
      } else {
        runner = new DeepInfraApiRunner(modelId)
      }
    } else {
      runner = offline
        ? new DeepInfraApiRunner(resolveFallbackModelId())
        : new OpenRouterApiRunner(LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0])
    }
  }
  return runner
}

/** Synthesize an answer and settle usage against the captured submission owner. */
export async function synthesizeChatAnswer(
  runner: ChatProviderRunner,
  prompt: string,
  callbacks: ChatCallbacks,
  usageScope: ChatUsageScope,
  effects: ChatProviderUsageEffects,
): Promise<string> {
  const context: ChatProviderRetryContext = {
    deliveryMode: 'text',
    conversationState: prompt,
    executionStage: 'synthesis',
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
  if (runner instanceof OllamaApiRunner) return false
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
  return runner instanceof OllamaApiRunner
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
    const restrictTools = nextTools.restrict && !isReadOnlyChat() && input.acceptedOperation !== 'READ_ONLY'
    const toolDefs = filterReadOnlyTaskTools(filterReadOnlyChatTools(
      restrictTools
        ? input.tools.buildRestrictedDefinitions(
            nextTools.mode === 'full' ? 'act_or_verify' : nextTools.mode,
          )
        : input.tools.buildDefinitions(),
    ), input.acceptedOperation, input.requiredVerifierCommands ?? [])
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
  failed: (error: string) => ChatEvent
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
  DeepInfraApiRunner | DeepSeekApiRunner | OpenRouterApiRunner | null,
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
  if (input.modelPolicy?.provider === 'opencode-go') {
    yield input.failed(`${err.message} [LIVE_MODEL_POLICY] exact Go route refuses provider substitution`)
    return null
  }
  // Runtime Pro → Flash failover with visible reason (not verification)
  const modelId = input.options.model ?? 'deepseek-v4-pro'
  const decision = input.tryFailover(modelId, err)
  const exactGlmLocked =
    input.modelPolicy?.provider === 'openrouter' &&
    input.modelPolicy.providerModelId === LIVE_OPENROUTER_MODEL_ID
  if (exactGlmLocked && decision) {
    // The exact GLM campaign is provider/model locked. A generic Pro→Flash
    // decision must never cross that boundary into DeepSeek.
    yield input.failed(
      `${err.message} [LIVE_MODEL_POLICY] exact GLM route refuses provider substitution`,
    )
    return null
  }
  let fb = input.resolveFallback()
  if (!fb && decision) {
    const routedModel = resolveOpenRouterDeepSeekModelId(decision.toModel)
    if (!routedModel) {
      yield input.failed(
        `${err.message} [LIVE_MODEL_POLICY] failover route is not OpenRouter-approved`,
      )
      return null
    }
    fb = new OpenRouterApiRunner(routedModel)
    input.installFailover(fb, decision)
    yield {
      type: 'thought',
      text: `[Failover] ${decision.reason} (not independent verification)`,
    }
    return fb
  }
  if (!fb) {
    yield input.failed(err.message)
    return null
  }
  yield {
    type: 'thought',
    text: decision
      ? `[Failover] ${decision.reason}`
      : 'Retrying with fallback model…',
  }
  return fb
}
